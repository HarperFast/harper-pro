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
 * with no restart. Proof is end-to-end: the subscriber's cluster_status must return to connected:true with the
 * retried copy complete, and a record written on the source after that must replicate to it.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, postOperation, readLog, waitForCondition } from './clusterShared.mjs';

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
const SETUP_PHASE_TIMEOUT_MS = 30000;
const RECOVERY_TIMEOUT_MS = 40000;
const POLL_INTERVAL_MS = 250;
const NODE_STARTUP_ALLOWANCE_MS = 60000;
const SUITE_TIMEOUT_MS = NODE_STARTUP_ALLOWANCE_MS + 2 * SETUP_PHASE_TIMEOUT_MS + 2 * RECOVERY_TIMEOUT_MS;

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

async function dataSocketTo(node, peer, signal) {
	const status = await sendOperation(node, { operation: 'cluster_status' }, { signal });
	return status.connections
		.find((connection) => connection.name === peer.hostname)
		?.database_sockets?.find((socket) => socket.database === STALL_DB);
}

const dataDbTag = `(db: "${STALL_DB}")`;
const isDataCopyStartLine = (line) => line.includes('bulk copy starting from') && line.includes(dataDbTag);

suite('Replication copy-progress wedge recovery', { timeout: SUITE_TIMEOUT_MS }, (ctx) => {
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
		const [source, subscriber] = ctx.nodes;
		// node1 subscribes to node0 for `data`. The first outbound copy from node0 stalls right after
		// COPY_START; node1 is left connected:true with the copy frozen while pings flow.
		// add_node sends its CSR to node0's replication port; under load that listener can still be binding.
		// Only a refused connection is retried: the peer never saw the request, so no state was written.
		let lastAddNode;
		await waitForCondition(
			async (signal) => {
				lastAddNode = await postOperation(
					subscriber,
					{
						operation: 'add_node',
						rejectUnauthorized: false,
						hostname: source.hostname,
						authorization: subscriber.admin,
					},
					{ signal }
				);
				if (lastAddNode.status === 200) return true;
				if (JSON.stringify(lastAddNode.body).includes('ECONNREFUSED')) return false;
				throw new Error(`add_node failed (${lastAddNode.status}): ${JSON.stringify(lastAddNode.body)}`);
			},
			{
				timeoutMs: SETUP_PHASE_TIMEOUT_MS,
				pollMs: POLL_INTERVAL_MS,
				description: () => `add_node to be accepted; last response ${JSON.stringify(lastAddNode)}`,
			}
		);

		// The watchdog's detection bound below is measured from this line, and no cluster_status field marks
		// COPY_START during this stall: connected:true is stamped at the handshake, and the source's
		// `sendingMessage: 'Copying'` only once it sends a record, which the stall precedes.
		await waitForCondition(async () => (await readLog(subscriber)).split('\n').some(isDataCopyStartLine), {
			timeoutMs: SETUP_PHASE_TIMEOUT_MS,
			pollMs: POLL_INTERVAL_MS,
			description: 'the subscriber to log the start of the data copy',
		});

		// The copy-progress watchdog fires (COPY_STALL_TIMEOUT plus its 2×pingInterval transport-evidence
		// confirmation), forceReconnect re-establishes, and the retried copy completes. The byte watchdog
		// (pingTimeout) is deliberately shorter yet must NOT recover anything, because pings keep bytesRead
		// advancing — proving copy-progress is the recovery path. lastReceivedVersion is frozen at 0 for the
		// whole copy and advances only on the copy's final end_txn, so a positive value means the retried
		// copy finished its walk.
		let lastSocket;
		await waitForCondition(
			async (signal) => {
				lastSocket = await dataSocketTo(subscriber, source, signal);
				return lastSocket?.connected === true && lastSocket.lastReceivedVersion > 0;
			},
			{
				timeoutMs: RECOVERY_TIMEOUT_MS,
				pollMs: POLL_INTERVAL_MS,
				description: () =>
					`the stalled copy to recover: data socket connected with the retried copy complete; last ${JSON.stringify(lastSocket)}`,
			}
		);

		// A record written after the retried copy's snapshot only replicates through live audit replay, so its
		// arrival proves replication resumed without a restart.
		const recordId = 'after-stall-1';
		await sendOperation(source, {
			operation: 'insert',
			database: STALL_DB,
			table: 'test',
			records: [{ id: recordId, name: 'recovered' }],
		});
		await waitForCondition(
			async (signal) => {
				const result = await sendOperation(
					subscriber,
					{ operation: 'search_by_id', database: STALL_DB, table: 'test', ids: [recordId], get_attributes: ['*'] },
					{ signal }
				);
				return Array.isArray(result) && result.some((r) => r?.id === recordId);
			},
			{
				timeoutMs: RECOVERY_TIMEOUT_MS,
				pollMs: POLL_INTERVAL_MS,
				description: 'the record written after recovery to replicate to the subscriber (no restart)',
			}
		);

		// The seed record copied in the base copy should also be present once the copy completed.
		const seed = await sendOperation(subscriber, {
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

		// The recovery actor must be the copy-progress watchdog, within its documented bound and
		// with no byte-level fire — scoped to the data connection so the system database's own
		// socket cannot leak into the oracles (harper-pro#697).
		const log = await readLog(subscriber);
		const lineTime = (line) => Date.parse(line.slice(0, 24));
		const fires = log
			.split('\n')
			.filter((line) => line.includes('Copy-progress watchdog:') && line.includes(dataDbTag));
		ok(fires.length >= 1, 'the copy-progress watchdog must have fired on the data connection to drive the recovery');
		const byteFires = log.split('\n').filter((line) => line.includes('Receive watchdog:') && line.includes(dataDbTag));
		ok(byteFires.length === 0, 'no byte-level watchdog may act on this ping-alive wedge');
		// The bound is measured from COPY_START — where noteCopyProgress() first arms the timer —
		// not from the subscription request, whose setup gates can add unbounded scheduling delay.
		const copyStartLine = log.split('\n').find(isDataCopyStartLine);
		const detectionMs = lineTime(fires[0]) - lineTime(copyStartLine);
		ok(
			detectionMs <= COPY_STALL_TIMEOUT_MS * 2 + PING_INTERVAL_MS * 2 + 5000,
			`copy-progress fire must land within its documented bound; took ${detectionMs}ms`
		);
	});
});
