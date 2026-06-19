/**
 * Open-but-idle replication wedge recovery (harper-pro#420).
 *
 * Field incident (JJill preprod, 5.1.5): after a cluster-wide simultaneous restart a per-DB receive
 * socket settled "open but idle" — connected at the transport level, no bytes flowing, and no `close`
 * event ever fired. The receive watchdog's `ws.terminate()` did not lead to recovery, the connection's
 * node entry stayed `connected:true`, and the wedged `(peer, db)` pair made zero further connection
 * attempts for over an hour, blocking replicated deploys. Only a manual staggered restart cleared it.
 *
 * The fix drives recovery from the watchdog through `NodeReplicationConnection.forceReconnect()`, which
 * tears the socket down and schedules a fresh `connect()` independent of whether `close` ever fires.
 *
 * This test reproduces the exact no-`close` condition deterministically via the env-gated, one-shot
 * `armReplicationWedgeForTest` hook: the first receive connection for the named DB is forced into the
 * open-but-idle wedge (the watchdog observes frozen bytes, and the socket's terminate/close are
 * neutralized so no `close` arrives). On the pre-#420 code this stays wedged forever (the test would time
 * out); with the fix the connection reconnects on its own and replication resumes — with no restart.
 *
 * Proof of recovery is end-to-end: a record written on the source AFTER the wedge fires must replicate to
 * the wedged subscriber, and `cluster_status` must return to `connected:true`.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const NODE_COUNT = 2;
const WEDGE_DB = 'data';
// Short ping/watchdog windows so the receive watchdog fires within the test instead of the 60s default.
// Healthy connections pong every pingInterval (1s) so their watchdogs never false-fire; only the
// frozen-bytes wedged connection trips at pingTimeout.
const PING_INTERVAL_MS = 1000;
const PING_TIMEOUT_MS = 3000;
const RECOVERY_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 250;

function nodeStartOptions(node, { wedge = false } = {}) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true },
			replication: {
				securePort: node.hostname + ':9933',
				databases: [WEDGE_DB],
				pingInterval: PING_INTERVAL_MS,
				pingTimeout: PING_TIMEOUT_MS,
			},
		},
		// The wedge hook is per-process and one-shot; arming it only on the subscriber pins which
		// (peer, db) receive socket gets forced open-but-idle.
		env: wedge ? { HARPER_TEST_REPLICATION_WEDGE_DB: WEDGE_DB } : undefined,
	};
}

async function dataSocketConnected(node) {
	const status = await sendOperation(node, { operation: 'cluster_status' });
	return status.connections.some(
		(conn) => conn.database_sockets?.length > 0 && conn.database_sockets.every((socket) => socket.connected === true)
	);
}

suite('Replication open-but-idle wedge recovery', { timeout: 120000 }, (ctx) => {
	before(async () => {
		// node[0] is the source, node[1] the subscriber whose receive socket is wedged.
		ctx.nodes = [];
		for (let i = 0; i < NODE_COUNT; i++) {
			const nodeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			const wedge = i === 1; // only the subscriber arms the one-shot wedge hook
			ctx.nodes[i] = (await startHarper(nodeCtx, nodeStartOptions(nodeCtx.harper, { wedge }))).harper;
		}
		await Promise.all(
			ctx.nodes.map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					database: WEDGE_DB,
					table: 'test',
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'name', type: 'String' },
					],
				})
			)
		);
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('a wedged open-but-idle receive socket reconnects on its own (no restart)', async () => {
		// node1 subscribes to node0 for `data`. The first receive connection arms the wedge hook.
		await sendOperation(ctx.nodes[1], {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.nodes[0].hostname,
			authorization: ctx.nodes[1].admin,
		});

		// Let the wedge fire (watchdog at ~PING_TIMEOUT) and forceReconnect re-establish. The window is
		// past the watchdog threshold plus a reconnect/backoff margin, so the record written next can only
		// arrive over the RECOVERED socket — not the original pre-wedge one.
		await delay(PING_TIMEOUT_MS + 5000);

		const recordId = 'after-wedge-1';
		await sendOperation(ctx.nodes[0], {
			operation: 'insert',
			database: WEDGE_DB,
			table: 'test',
			records: [{ id: recordId, name: 'recovered' }],
		});

		// Poll the wedged subscriber until the post-wedge write lands — recovery without a restart.
		const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
		let replicated = false;
		while (Date.now() < deadline) {
			const result = await sendOperation(ctx.nodes[1], {
				operation: 'search_by_id',
				database: WEDGE_DB,
				table: 'test',
				ids: [recordId],
				get_attributes: ['*'],
			});
			if (Array.isArray(result) && result.some((r) => r?.id === recordId)) {
				replicated = true;
				break;
			}
			await delay(POLL_INTERVAL_MS);
		}
		ok(replicated, 'record written after the wedge must replicate to the recovered subscriber (no restart)');

		// And the socket-level view should be back to connected.
		const deadlineConnected = Date.now() + RECOVERY_TIMEOUT_MS;
		let connected = false;
		while (Date.now() < deadlineConnected) {
			if (await dataSocketConnected(ctx.nodes[1])) {
				connected = true;
				break;
			}
			await delay(POLL_INTERVAL_MS);
		}
		ok(connected, 'cluster_status should report the recovered data socket as connected');
	});
});
