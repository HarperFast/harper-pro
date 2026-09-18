import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, readLog, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const DB = 'data';
const TABLE = 'setup_recovery';
const SETUP_TIMEOUT_MS = 3000;
const RECOVERY_TIMEOUT_MS = 30000;
const CONVERGENCE_POLL_MS = 250;
const DIAGNOSTIC_TIMEOUT_MS = 5000;

function optionsFor(node, env, databases = [DB, 'system']) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true, level: 'warn' },
			threads: { count: 1 },
			replication: {
				securePort: node.hostname + ':9933',
				databases,
				pingInterval: 1000,
				pingTimeout: 3000,
			},
		},
		env,
	};
}

async function hasRecord(node, id, signal) {
	const result = await sendOperation(
		node,
		{
			operation: 'search_by_id',
			database: DB,
			table: TABLE,
			ids: [id],
			get_attributes: ['id'],
		},
		{ signal }
	);
	return Array.isArray(result) && result.some((record) => record?.id === id);
}

/**
 * `cluster_status` returns the peer's whole hdb_nodes record minus `ca` and the timestamps, so it
 * can carry a retained `authorization` credential (setNode.ts:231) — project, never serialize it.
 * Bounded separately and never throwing: collecting evidence must not replace the failure it is
 * evidence for.
 */
async function replicationDiagnostics(node) {
	const controller = new AbortController();
	const deadline = setTimeout(
		() => controller.abort(new Error(`cluster_status did not answer within ${DIAGNOSTIC_TIMEOUT_MS}ms`)),
		DIAGNOSTIC_TIMEOUT_MS
	);
	try {
		const status = await sendOperation(node, { operation: 'cluster_status' }, { signal: controller.signal });
		return JSON.stringify(
			status.connections?.map((connection) => ({
				name: connection.name,
				database_sockets: connection.database_sockets?.map((socket) => ({
					database: socket.database,
					connected: socket.connected,
					lastReceivedStatus: socket.lastReceivedStatus,
					lastReceivedVersion: socket.lastReceivedVersion,
					lastReceivedLocalTime: socket.lastReceivedLocalTime,
					lastLiveness: socket.lastLiveness,
					sendingMessage: socket.sendingMessage,
					backPressurePercent: socket.backPressurePercent,
					recoveryFires: socket.recoveryFires,
					lastConnectionError: socket.lastConnectionError,
				})),
			}))
		);
	} catch (error) {
		return `cluster_status unavailable: ${error.message}`;
	} finally {
		clearTimeout(deadline);
	}
}

/**
 * A probe error is recorded rather than rethrown, and reported beside the snapshot: a node
 * answering 500 while replication is healthy must stay distinguishable from non-convergence.
 */
async function waitForConvergence(node, probe, description, timeoutMs = RECOVERY_TIMEOUT_MS) {
	let lastProbeError;
	try {
		await waitForCondition(
			async (signal) => {
				try {
					return await probe(signal);
				} catch (error) {
					lastProbeError = error;
					return false;
				}
			},
			{ timeoutMs, pollMs: CONVERGENCE_POLL_MS, description }
		);
	} catch (error) {
		throw new Error(
			`${error.message}; last probe error: ${lastProbeError?.message ?? 'none'}; ${node.hostname} ${await replicationDiagnostics(node)}`,
			{ cause: error }
		);
	}
}

function waitForRecord(node, id, description, timeoutMs = RECOVERY_TIMEOUT_MS) {
	return waitForConvergence(node, (signal) => hasRecord(node, id, signal), description, timeoutMs);
}

async function waitForLog(node, pattern, timeoutMs = RECOVERY_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const log = await readLog(node);
		if (pattern.test(log)) return log;
		await delay(250);
	}
	return '';
}

async function teardownNode(node) {
	try {
		await teardownHarper({ harper: node });
	} catch (err) {
		console.error(`Failed to tear down node ${node.hostname}:`, err);
	}
}

function countSetupWatchdogWarnings(log, database = DB) {
	return log
		.split('\n')
		.filter((line) => line.includes('Subscription-setup watchdog:') && line.includes(`(db: "${database}")`)).length;
}

async function socketConnected(node, database, signal) {
	const status = await sendOperation(node, { operation: 'cluster_status' }, { signal });
	return status.connections.some((connection) =>
		connection.database_sockets?.some((socket) => socket.database === database && socket.connected === true)
	);
}

function waitForSocket(node, database, description, timeoutMs = RECOVERY_TIMEOUT_MS) {
	return waitForConvergence(node, (signal) => socketConnected(node, database, signal), description, timeoutMs);
}

async function hasRole(node, role, signal) {
	const roles = await sendOperation(node, { operation: 'list_roles' }, { signal });
	return Array.isArray(roles) && roles.some((entry) => entry?.role === role);
}

function waitForRole(node, role, description, timeoutMs = RECOVERY_TIMEOUT_MS) {
	return waitForConvergence(node, (signal) => hasRole(node, role, signal), description, timeoutMs);
}

suite('subscription setup recovery', { timeout: 120000 }, (ctx) => {
	before(async () => {
		const sourceCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const receiverCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await Promise.all([
			startHarper(sourceCtx, optionsFor(sourceCtx.harper, { HARPER_TEST_SUBSCRIPTION_SETUP_STALL_ONCE_DB: DB })),
			startHarper(
				receiverCtx,
				optionsFor(receiverCtx.harper, { HARPER_TEST_SUBSCRIPTION_SETUP_TIMEOUT_MS: String(SETUP_TIMEOUT_MS) })
			),
		]);
		ctx.source = sourceCtx.harper;
		ctx.receiver = receiverCtx.harper;

		await Promise.all(
			[ctx.source, ctx.receiver].map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					database: DB,
					table: TABLE,
					primary_key: 'id',
					attributes: [{ name: 'id', type: 'ID' }],
				})
			)
		);
	});

	after(async () => {
		await Promise.all([ctx.source, ctx.receiver].filter(Boolean).map(teardownNode));
	});

	test('a ping-alive setup hang reconnects and converges without a restart', async () => {
		await sendOperation(ctx.receiver, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.source.hostname,
			authorization: ctx.receiver.admin,
		});

		const sourceStallLog = await waitForLog(ctx.source, /\[test\] stalling subscription setup before DB_SCHEMA/);
		assert.match(sourceStallLog, /\[test\] stalling subscription setup before DB_SCHEMA/);
		const recoveryLog = await waitForLog(ctx.receiver, /Subscription-setup watchdog:.*\(db: "data"\)/);
		assert.match(
			recoveryLog,
			/Subscription-setup watchdog:.*\(db: "data"\)/,
			'the receiver data watchdog must drive recovery'
		);

		const first = `after-setup-watchdog-${Date.now()}`;
		await sendOperation(ctx.source, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [{ id: first }],
		});
		await waitForRecord(
			ctx.receiver,
			first,
			'a record written after the setup hang to arrive over the recovered subscription'
		);
		assert.equal(await socketConnected(ctx.receiver, DB), true, 'the recovered data socket must be connected');

		const warningsBeforeIdle = countSetupWatchdogWarnings(await readLog(ctx.receiver));
		assert.ok(warningsBeforeIdle >= 1, 'at least one setup-watchdog recovery should have occurred');
		await delay(SETUP_TIMEOUT_MS * 3);
		const second = `after-idle-${Date.now()}`;
		await sendOperation(ctx.source, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [{ id: second }],
		});
		await waitForRecord(ctx.receiver, second, 'healthy idle not to rearm setup recovery');
		assert.equal(
			countSetupWatchdogWarnings(await readLog(ctx.receiver)),
			warningsBeforeIdle,
			'healthy idle must not cause setup-watchdog reconnect churn'
		);
	});

	test('a convergence timeout reports the replication state it was waiting on', async () => {
		const neverConverges = await waitForConvergence(
			ctx.receiver,
			() => false,
			'a condition that never holds',
			1000
		).then(
			() => undefined,
			(error) => error
		);
		assert.match(neverConverges.message, /Timed out after 1000ms waiting for a condition that never holds/);
		assert.match(neverConverges.message, /"lastReceivedStatus":/, 'the snapshot must carry the receive state');
		assert.match(neverConverges.message, /"recoveryFires"|"connected":/, 'the snapshot must carry the link truth');
		assert.doesNotMatch(
			neverConverges.message,
			/authorization/i,
			'the snapshot must project replication fields, never the whole hdb_nodes record'
		);
		assert.match(neverConverges.message, /last probe error: none/);

		const probeThrew = await waitForConvergence(
			ctx.receiver,
			() => {
				throw new Error('probe exploded');
			},
			'a condition whose probe fails',
			1000
		).then(
			() => undefined,
			(error) => error
		);
		assert.match(
			probeThrew.message,
			/last probe error: probe exploded/,
			'a broken oracle must be distinguishable from non-convergence'
		);

		const unreachable = { ...ctx.receiver, operationsAPIURL: 'http://127.0.0.1:1/' };
		assert.match(await replicationDiagnostics(unreachable), /^cluster_status unavailable: /);
	});
});

suite('sender subscription setup recovery', { timeout: 120000 }, (ctx) => {
	before(async () => {
		const sourceCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const receiverCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await Promise.all([
			startHarper(
				sourceCtx,
				optionsFor(sourceCtx.harper, {
					HARPER_TEST_SUBSCRIPTION_SETUP_STALL_ONCE_DB: DB,
					HARPER_TEST_SEND_SUBSCRIPTION_RESOLVE_TIMEOUT_MS: '2000',
				})
			),
			startHarper(receiverCtx, optionsFor(receiverCtx.harper, { HARPER_TEST_SUBSCRIPTION_SETUP_TIMEOUT_MS: '20000' })),
		]);
		ctx.source = sourceCtx.harper;
		ctx.receiver = receiverCtx.harper;

		await Promise.all(
			[ctx.source, ctx.receiver].map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					database: DB,
					table: TABLE,
					primary_key: 'id',
					attributes: [{ name: 'id', type: 'ID' }],
				})
			)
		);
	});

	after(async () => {
		await Promise.all([ctx.source, ctx.receiver].filter(Boolean).map(teardownNode));
	});

	test('the bounded sender gate closes first and the replacement subscription converges', async () => {
		await sendOperation(ctx.receiver, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.source.hostname,
			authorization: ctx.receiver.admin,
		});

		const timeoutLog = await waitForLog(ctx.source, /Timed out waiting for authorization subscription setup/);
		assert.match(timeoutLog, /Timed out waiting for authorization subscription setup/);
		assert.doesNotMatch(
			await readLog(ctx.receiver),
			/Subscription-setup watchdog:.*\(db: "data"\)/,
			'the longer receiver backstop must not race the sender gate timeout'
		);

		const id = `after-sender-timeout-${Date.now()}`;
		await sendOperation(ctx.source, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [{ id }],
		});
		await waitForRecord(ctx.receiver, id, 'the sender-timeout retry to converge');
		assert.doesNotMatch(
			await readLog(ctx.receiver),
			/Subscription-setup watchdog:.*\(db: "data"\)/,
			'the receiver data watchdog must remain quiet after sender-driven convergence'
		);
	});
});

suite('system subscription setup recovery', { timeout: 120000 }, (ctx) => {
	before(async () => {
		const sourceCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const receiverCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await Promise.all([
			startHarper(
				sourceCtx,
				optionsFor(sourceCtx.harper, { HARPER_TEST_SUBSCRIPTION_SETUP_STALL_ONCE_DB: 'system' }, ['system'])
			),
			startHarper(
				receiverCtx,
				optionsFor(receiverCtx.harper, { HARPER_TEST_SUBSCRIPTION_SETUP_TIMEOUT_MS: '3000' }, ['system'])
			),
		]);
		ctx.source = sourceCtx.harper;
		ctx.receiver = receiverCtx.harper;
	});

	after(async () => {
		await Promise.all([ctx.source, ctx.receiver].filter(Boolean).map(teardownNode));
	});

	test('an unsolicited handshake schema cannot acknowledge the stalled system request', async () => {
		await sendOperation(ctx.receiver, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.source.hostname,
			authorization: ctx.receiver.admin,
		});

		assert.match(
			await waitForLog(ctx.source, /\[test\] stalling subscription setup before DB_SCHEMA for db "system"/),
			/\[test\] stalling subscription setup before DB_SCHEMA for db "system"/
		);
		assert.match(
			await waitForLog(ctx.receiver, /Subscription-setup watchdog:.*\(db: "system"\)/),
			/Subscription-setup watchdog:.*\(db: "system"\)/,
			'the unsolicited handshake schema must not retire the correlated system request'
		);
		await waitForSocket(ctx.receiver, 'system', 'the replacement system socket to connect');

		const role = `after-system-setup-watchdog-${Date.now()}`;
		await sendOperation(ctx.source, { operation: 'add_role', role, permission: { super_user: false } });
		await waitForRole(ctx.receiver, role, 'system-table replication to converge after recovery');
		assert.ok(
			countSetupWatchdogWarnings(await readLog(ctx.receiver), 'system') >= 1,
			'the correlated system request should trigger recovery'
		);
	});
});
