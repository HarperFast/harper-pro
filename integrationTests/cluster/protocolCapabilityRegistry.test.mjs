/**
 * What only real nodes can prove: the frame-dispatch default case is reached through the real switch, and
 * both ends of a mixed-version pair report the other through the real `cluster_status` operation.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const DB = 'data';
const TABLE = 'capability_registry';
const UNKNOWN_COMMAND_CODE = 200;
const CONVERGE_TIMEOUT_MS = 60000;

// Literal, not imported: changing either constant must be a deliberate wire decision, not a silently green test.
const LOCAL_PROTOCOL_VERSION = 2;
const MINIMUM_PROTOCOL_VERSION = 1;
const SUBSCRIPTION_SETUP_ACK_CAPABILITY = 1;

function optionsFor(node, env) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true, level: 'warn' },
			threads: { count: 1 },
			replication: {
				securePort: node.hostname + ':9933',
				databases: [DB, 'system'],
				pingInterval: 1000,
				pingTimeout: 3000,
			},
		},
		env,
	};
}

async function socketFor(node, database) {
	const status = await sendOperation(node, { operation: 'cluster_status' }).catch(() => null);
	for (const connection of status?.connections ?? []) {
		for (const socket of connection.database_sockets ?? []) {
			if (socket.database === database) return socket;
		}
	}
	return undefined;
}

function waitForSocket(node, database, predicate, description) {
	return waitForCondition(
		async () => {
			const socket = await socketFor(node, database);
			return socket && predicate(socket) ? socket : undefined;
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description }
	);
}

async function insert(node, id) {
	await sendOperation(node, { operation: 'insert', database: DB, table: TABLE, records: [{ id }] });
}

function waitForRecord(node, id) {
	return waitForCondition(
		async () => {
			const result = await sendOperation(node, {
				operation: 'search_by_id',
				database: DB,
				table: TABLE,
				ids: [id],
				get_attributes: ['id'],
			}).catch(() => null);
			return Array.isArray(result) && result.some((record) => record?.id === id);
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: `record ${id} on ${node.hostname}` }
	);
}

suite('protocol capability registry', { timeout: 180000 }, (ctx) => {
	before(async () => {
		const currentCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const legacyCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await Promise.all([
			startHarper(currentCtx, optionsFor(currentCtx.harper, {})),
			startHarper(
				legacyCtx,
				optionsFor(legacyCtx.harper, {
					HARPER_TEST_OMIT_REPLICATION_CAPABILITIES: '1',
					HARPER_TEST_SEND_UNKNOWN_COMMAND_CODE: String(UNKNOWN_COMMAND_CODE),
				})
			),
		]);
		ctx.current = currentCtx.harper;
		ctx.legacy = legacyCtx.harper;
		ctx.legacyCtx = legacyCtx;

		await Promise.all(
			[ctx.current, ctx.legacy].map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					database: DB,
					table: TABLE,
					primary_key: 'id',
					attributes: [{ name: 'id', type: 'ID' }],
				})
			)
		);
		await sendOperation(ctx.current, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.legacy.hostname,
			authorization: ctx.current.admin,
		});
	});

	after(async () => {
		for (const node of [ctx.current, ctx.legacy].filter(Boolean)) {
			await stopNodeProcess(node).catch(() => {});
			await teardownHarper({ harper: node }).catch((err) =>
				console.error(`Failed to tear down node ${node.hostname}:`, err)
			);
		}
	});

	test('each end reports the effective capabilities of the other, and a bag-less peer still converges', async () => {
		const legacyPeerSocket = await waitForSocket(
			ctx.current,
			DB,
			(socket) => socket.connected && socket.peerCapabilities,
			'the current node to report capabilities for its bag-less peer'
		);
		assert.equal(
			legacyPeerSocket.peerCapabilities.protocolVersion,
			MINIMUM_PROTOCOL_VERSION,
			'a peer that advertises no bag must resolve to the minimum protocol version'
		);
		assert.equal(
			legacyPeerSocket.peerCapabilities.subscriptionSetupAck,
			0,
			'a peer that advertises no bag must not be treated as supporting setup acknowledgement'
		);
		assert.equal(
			legacyPeerSocket.peerCapabilities.subscriptionSetupBudgetMs,
			undefined,
			'no budget can be adopted from a peer that advertised none'
		);

		const currentPeerSocket = await waitForSocket(
			ctx.legacy,
			DB,
			(socket) => socket.connected && socket.peerCapabilities,
			'the bag-less node to report capabilities for its current peer'
		);
		assert.equal(currentPeerSocket.peerCapabilities.protocolVersion, LOCAL_PROTOCOL_VERSION);
		assert.equal(currentPeerSocket.peerCapabilities.subscriptionSetupAck, SUBSCRIPTION_SETUP_ACK_CAPABILITY);
		assert.equal(
			typeof currentPeerSocket.peerCapabilities.subscriptionSetupBudgetMs,
			'number',
			'a current peer advertises its two-gate setup budget'
		);
		assert.equal(
			currentPeerSocket.unknownCommandFrames,
			undefined,
			'a link that received no unrecognized frame must omit the counter entirely'
		);

		const fromCurrent = `from-current-${Date.now()}`;
		const fromLegacy = `from-legacy-${Date.now()}`;
		await insert(ctx.current, fromCurrent);
		await insert(ctx.legacy, fromLegacy);
		assert.equal(await waitForRecord(ctx.legacy, fromCurrent), true);
		assert.equal(await waitForRecord(ctx.current, fromLegacy), true);
	});

	test('an unrecognized command frame is counted and reported, and the connection keeps working', async () => {
		const socket = await waitForSocket(
			ctx.current,
			DB,
			(s) => s.unknownCommandFrames > 0,
			'the unrecognized-frame counter to reach cluster_status'
		);
		assert.ok(
			socket.unknownCommandFrames >= 1,
			`expected at least one counted unrecognized frame, got ${socket.unknownCommandFrames}`
		);
		assert.equal(socket.connected, true, 'an unrecognized frame must not take the connection down');

		const afterUnknown = `after-unknown-${Date.now()}`;
		await insert(ctx.legacy, afterUnknown);
		assert.equal(await waitForRecord(ctx.current, afterUnknown), true);
	});

	test('a reconnected peer is re-learned, not carried over from the retired socket', async () => {
		// Restart the bag-less node as a CURRENT one. Asserting the same values as before the restart would
		// pass on a stale leftover and prove nothing; a changed bag can only have come from the new socket.
		await stopNodeProcess(ctx.legacy);
		await startHarper(ctx.legacyCtx, optionsFor(ctx.legacy, {}));
		ctx.legacy = ctx.legacyCtx.harper;

		const relearned = await waitForSocket(
			ctx.current,
			DB,
			(socket) => socket.connected && socket.peerCapabilities?.protocolVersion === LOCAL_PROTOCOL_VERSION,
			'the reconnected peer to be re-learned as a current build'
		);
		assert.equal(relearned.peerCapabilities.subscriptionSetupAck, SUBSCRIPTION_SETUP_ACK_CAPABILITY);
		assert.equal(typeof relearned.peerCapabilities.subscriptionSetupBudgetMs, 'number');

		const afterRestart = `after-restart-${Date.now()}`;
		await insert(ctx.legacy, afterRestart);
		assert.equal(await waitForRecord(ctx.current, afterRestart), true);
	});
});
