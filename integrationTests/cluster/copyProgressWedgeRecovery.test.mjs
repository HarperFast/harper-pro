/**
 * Copy-progress wedge recovery (harper-pro#453).
 *
 * Field incident (a customer preprod cluster, 5.1.7; harper-pro#453): a rolling upgrade restart
 * interrupted the `system` base copy,
 * and the follower's receive subscription settled connected:true / `lastReceivedStatus:"Receiving"` with
 * the copy frozen at version 0 — permanently. Two existing safety nets both missed it because both key
 * off connected:false:
 *   - the connected:false wedge-reconcile (`findWedgedNodeUrls`) never looked at a connected:true entry;
 *   - the byte-level receive watchdog never fired because keepalive pings kept `bytesRead` advancing.
 * So new `hdb_deployment` rows could not replicate (live audit replay only starts after COPY_COMPLETE),
 * and replicated deploys timed out — for hours, with no self-heal. Only a manual staggered restart cleared it.
 *
 * The fix adds a copy-progress watchdog keyed on received copy app-frames (pings are WS control frames, not
 * 'message' events, so they don't advance it). If we're mid-copy and no copy frame arrives for the
 * copy-stall threshold (REPLICATION_BLOBTIMEOUT) while still connected, it forces the same close-independent
 * reconnect the byte watchdog uses, which restarts the copy from the leader.
 *
 * This test reproduces the exact ping-alive copy stall deterministically via the env-gated, one-shot
 * `HARPER_TEST_COPY_STALL_ONCE_DB` hook on the SOURCE: the first outbound base copy for the named DB stalls
 * right after COPY_START (no further frames, no COPY_COMPLETE) while the sendPing timer keeps the socket
 * ping-alive. On the pre-#453 code the subscriber stays wedged forever (the test would time out); with the
 * fix the copy-progress watchdog reconnects on its own, the retried copy completes, and replication resumes —
 * with no restart. Proof is end-to-end: a record written on the source AFTER the stall must replicate to the
 * wedged subscriber, and cluster_status must return to connected:true.
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
const STALL_DB = 'data';
// Healthy pings every 1s (so the byte watchdog never false-fires) but, crucially, keep the socket alive
// during the stall — reproducing the field condition where pings suppress the byte watchdog. The
// copy-progress watchdog uses the copy-stall threshold (blobTimeout) instead; keep it short so it fires
// within the test, but comfortably above pingTimeout so we can prove pings did NOT trigger recovery.
const PING_INTERVAL_MS = 1000;
const PING_TIMEOUT_MS = 3000;
const COPY_STALL_TIMEOUT_MS = 5000; // REPLICATION_BLOBTIMEOUT → the copy-progress watchdog threshold
// REPLICATION_COPYTIMEOUT — the byte watchdog's no-activity threshold *while in copy mode* (harper-pro#460).
// Set comfortably above COPY_STALL_TIMEOUT_MS so the copy-progress watchdog is provably the recovery path
// and the byte watchdog never fires during the stall (it would at the 3s pingTimeout if copy mode didn't
// widen it). This also pins the #460 behavior: the byte watchdog tolerates a long copy-phase silence.
const COPY_TIMEOUT_MS = 30000;
const RECOVERY_TIMEOUT_MS = 40000;
const POLL_INTERVAL_MS = 250;

function nodeStartOptions(node, { stall = false } = {}) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true },
			replication: {
				securePort: node.hostname + ':9933',
				databases: [STALL_DB],
				pingInterval: PING_INTERVAL_MS,
				pingTimeout: PING_TIMEOUT_MS,
				copyTimeout: COPY_TIMEOUT_MS,
				blobTimeout: COPY_STALL_TIMEOUT_MS,
			},
		},
		// The stall hook is per-process and one-shot; arming it only on the SOURCE pins which outbound
		// (peer, db) copy gets stalled right after COPY_START.
		env: stall ? { HARPER_TEST_COPY_STALL_ONCE_DB: STALL_DB } : undefined,
	};
}

async function dataSocketConnected(node) {
	const status = await sendOperation(node, { operation: 'cluster_status' });
	return status.connections.some(
		(conn) => conn.database_sockets?.length > 0 && conn.database_sockets.every((socket) => socket.connected === true)
	);
}

suite('Replication copy-progress wedge recovery', { timeout: 120000 }, (ctx) => {
	before(async () => {
		// node[0] is the source (arms the one-shot copy stall); node[1] is the subscriber that wedges.
		ctx.nodes = [];
		for (let i = 0; i < NODE_COUNT; i++) {
			const nodeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			const stall = i === 0; // only the source arms the one-shot copy-stall hook
			ctx.nodes[i] = (await startHarper(nodeCtx, nodeStartOptions(nodeCtx.harper, { stall }))).harper;
		}
		await Promise.all(
			ctx.nodes.map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					database: STALL_DB,
					table: 'test',
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'name', type: 'String' },
					],
				})
			)
		);
		// Seed a record on the source BEFORE the subscription so the base copy has content to carry and the
		// stall lands during a real copy, not an empty one.
		await sendOperation(ctx.nodes[0], {
			operation: 'insert',
			database: STALL_DB,
			table: 'test',
			records: [{ id: 'seed-1', name: 'seed' }],
		});
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('a copy stalled connected:true recovers on its own via the copy-progress watchdog (no restart)', async () => {
		// node1 subscribes to node0 for `data`. The first outbound copy from node0 stalls right after
		// COPY_START; node1 is left connected:true / "Receiving" with the copy frozen while pings flow.
		await sendOperation(ctx.nodes[1], {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.nodes[0].hostname,
			authorization: ctx.nodes[1].admin,
		});

		// Let the copy-progress watchdog fire (at ~COPY_STALL_TIMEOUT) and forceReconnect re-establish, so the
		// retried copy can complete. The byte watchdog (pingTimeout) is deliberately shorter yet must NOT
		// recover anything, because pings keep bytesRead advancing — proving copy-progress is the recovery path.
		await delay(COPY_STALL_TIMEOUT_MS + 8000);

		const recordId = 'after-stall-1';
		await sendOperation(ctx.nodes[0], {
			operation: 'insert',
			database: STALL_DB,
			table: 'test',
			records: [{ id: recordId, name: 'recovered' }],
		});

		// Poll the wedged subscriber until the post-stall write lands — recovery without a restart. A record
		// written after copyStartTime only replicates once the copy reaches COPY_COMPLETE and live audit
		// replay resumes, so its arrival proves the stalled copy converged.
		const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
		let replicated = false;
		while (Date.now() < deadline) {
			const result = await sendOperation(ctx.nodes[1], {
				operation: 'search_by_id',
				database: STALL_DB,
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
		ok(replicated, 'record written after the copy stall must replicate to the recovered subscriber (no restart)');

		// The seed record copied in the base copy should also be present once the copy completed.
		const seed = await sendOperation(ctx.nodes[1], {
			operation: 'search_by_id',
			database: STALL_DB,
			table: 'test',
			ids: ['seed-1'],
			get_attributes: ['*'],
		});
		ok(
			Array.isArray(seed) && seed.some((r) => r?.id === 'seed-1'),
			'the base-copy seed record must be present after the copy converged'
		);

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
