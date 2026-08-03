// harper-pro#642 end-to-end regression: a stuck sender-side setup gate must not leave the connection
// ping-alive forever; the receiver's watchdog must reconnect from the durable cursor and converge.

import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const DB = 'data';
const TABLE = 'setup_recovery';
const SETUP_TIMEOUT_MS = 3000;
const RECOVERY_TIMEOUT_MS = 30000;

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

async function hasRecord(node, id) {
	const result = await sendOperation(node, {
		operation: 'search_by_id',
		database: DB,
		table: TABLE,
		ids: [id],
		get_attributes: ['id'],
	}).catch(() => null);
	return Array.isArray(result) && result.some((record) => record?.id === id);
}

async function waitForRecord(node, id, timeoutMs = RECOVERY_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await hasRecord(node, id)) return true;
		await delay(250);
	}
	return false;
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

function countSetupWatchdogWarnings(log, database = DB) {
	return log
		.split('\n')
		.filter((line) => line.includes('Subscription-setup watchdog:') && line.includes(`(db: "${database}")`)).length;
}

async function socketConnected(node, database) {
	const status = await sendOperation(node, { operation: 'cluster_status' });
	return status.connections.some((connection) =>
		connection.database_sockets?.some((socket) => socket.database === database && socket.connected === true)
	);
}

async function waitForSocket(node, database, timeoutMs = RECOVERY_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await socketConnected(node, database).catch(() => false)) return true;
		await delay(250);
	}
	return false;
}

async function waitForRole(node, role, timeoutMs = RECOVERY_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const roles = await sendOperation(node, { operation: 'list_roles' }).catch(() => null);
		if (Array.isArray(roles) && roles.some((entry) => entry?.role === role)) return true;
		await delay(250);
	}
	return false;
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
		await Promise.all([ctx.source, ctx.receiver].filter(Boolean).map((node) => teardownHarper({ harper: node })));
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
		assert.equal(
			await waitForRecord(ctx.receiver, first),
			true,
			'a record written after the setup hang must arrive over the recovered subscription'
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
		assert.equal(await waitForRecord(ctx.receiver, second), true, 'healthy idle must not rearm setup recovery');
		assert.equal(
			countSetupWatchdogWarnings(await readLog(ctx.receiver)),
			warningsBeforeIdle,
			'healthy idle must not cause setup-watchdog reconnect churn'
		);
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
		await Promise.all([ctx.source, ctx.receiver].filter(Boolean).map((node) => teardownHarper({ harper: node })));
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
		assert.equal(await waitForRecord(ctx.receiver, id), true, 'the sender-timeout retry must converge');
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
		await Promise.all([ctx.source, ctx.receiver].filter(Boolean).map((node) => teardownHarper({ harper: node })));
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
		assert.equal(await waitForSocket(ctx.receiver, 'system'), true, 'the replacement system socket must connect');

		const role = `after-system-setup-watchdog-${Date.now()}`;
		await sendOperation(ctx.source, { operation: 'add_role', role, permission: { super_user: false } });
		assert.equal(await waitForRole(ctx.receiver, role), true, 'system-table replication must converge after recovery');
		assert.ok(
			countSetupWatchdogWarnings(await readLog(ctx.receiver), 'system') >= 1,
			'the correlated system request should trigger recovery'
		);
	});
});
