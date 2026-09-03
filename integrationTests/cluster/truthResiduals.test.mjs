/**
 * What this pins for the W1 connection-truth residuals (harper-pro#431), one case per residual:
 *
 *  - R1: with the peer frozen (so no close will ever arrive and its liveness stays fresh), killing the HTTP
 *    worker that owns the subscription still corrects truth to down, within two reconcile ticks and carrying
 *    the distinct worker-exit close code. The kill comes from fixture-worker-exit; see its resources.js for
 *    why no operation produces this fault.
 *  - R2: a remove_node + re-add inside one process reconnects with NO lastConnectionError. `unsubscribe()`
 *    closes with 1008 and nothing ever clears the error slots, so this is the field that would carry a
 *    failure the re-added link never suffered.
 *  - R3: a settled link publishes both copied link metrics, and the copied back-pressure ratio agrees with
 *    backPressurePercent, which cluster_status reads straight from the same slot.
 *  - R4: a wedge-reconcile fire that happens while truth already reads down lands in the redundant bucket,
 *    visible in cluster_status and in the fire log line.
 *
 * NOT pinned here: owner gating. Every fire this suite provokes is a main-thread net, which always owns the
 * subscription, so the `unknown` path that keeps non-owner fires out of the evidence is unit-only
 * (unitTests/replication/fireCounters.test.mjs).
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import {
	killHarper,
	startHarper,
	setupHarperWithFixture,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog, readNodePid, waitForCondition, fetchWithRetry } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

// replicationConnection.ts: the out-of-band LAST_ERROR_CODE for a disconnect inferred from a dead owner
// rather than observed on the wire. Duplicated here deliberately — the integration test asserts the
// operator-visible contract, so it must fail if the constant changes without a decision to change it.
const WORKER_EXIT_ERROR_CODE = 100001;
// subscriptionManager.ts: RECONCILE_INTERVAL_MS is 5s, so two ticks is the correction bound R1 promises.
// The old behavior — waiting out LIVENESS_STALE_MS — is >= 120s, so this bound cannot pass by accident.
const TRUTH_CORRECTION_BOUND_MS = 15000;
// subscriptionManager.ts WEDGE_RECONCILE_THRESHOLD_MS, plus a tick of slack for the reconcile to notice.
const WEDGE_FIRE_WAIT_MS = 45000;
const CONNECT_TIMEOUT_MS = 30000;
// Reconnecting after the peer has been down long enough to trip the wedge net is not the same wait as a
// first connect: the peer has to boot, and the subscriber's re-drive is itself on the 30s wedge cadence, so
// the worst case is a full cycle plus a boot. Bounded separately so a slow box does not read as a defect.
const RECONNECT_AFTER_RESTART_MS = 120000;
const REPLICATION_TIMEOUT_MS = 20000;
const POLL_MS = 250;

function nodeStartOptions(node) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true },
			replication: {
				securePort: node.hostname + ':9933',
				databases: ['data'],
			},
		},
	};
}

const clusterStatus = (node, signal) => sendOperation(node, { operation: 'cluster_status' }, { signal });

// The single (database, peer) socket this suite tracks. Returns undefined while the peer is not tracked at
// all, so callers can wait for either presence or absence.
function peerSocket(status, peerHostname) {
	const connection = status?.connections?.find(
		(entry) => entry.name === peerHostname || entry.url?.includes(peerHostname)
	);
	return connection?.database_sockets?.find((socket) => socket.database === 'data');
}

// cluster_status is served by the HTTP workers, so it is unavailable for a moment while they restart, and a
// node whose peer is frozen can be slow. Swallow only the transport failure — an assertion inside the probe
// still propagates.
async function pollPeerSocket(node, peerHostname, predicate, { timeoutMs, description }) {
	let last;
	await waitForCondition(
		async (signal) => {
			let socket;
			try {
				socket = peerSocket(await clusterStatus(node, signal), peerHostname);
			} catch (error) {
				if (signal.aborted) throw error;
				return false;
			}
			last = socket;
			return predicate(socket);
		},
		{ timeoutMs, pollMs: POLL_MS, description: () => `${description} (last observed: ${JSON.stringify(last)})` }
	);
	return last;
}

const addPeer = (node, peer) =>
	sendOperation(node, {
		operation: 'add_node',
		rejectUnauthorized: false,
		hostname: peer.hostname,
		authorization: node.admin,
	});

async function ensureSubscribed(node, peer) {
	const status = await clusterStatus(node);
	if (!peerSocket(status, peer.hostname)) await addPeer(node, peer);
	return pollPeerSocket(node, peer.hostname, (socket) => socket?.connected === true, {
		timeoutMs: CONNECT_TIMEOUT_MS,
		description: `${node.hostname} to report its subscription to ${peer.hostname} connected`,
	});
}

// Terminate the HTTP worker thread serving this request (fixture-worker-exit). Returns what that endpoint
// reported, including the thread id it is about to kill, so the caller can assert it really was the thread
// that owned the subscription.
async function killOwningWorker(node) {
	const response = await fetchWithRetry(`${node.httpURL}/KillHttpWorker/`, { retries: 5 });
	return response.json();
}

// Proves a link is genuinely carrying data, so `connected: true` is never taken on its own.
async function assertReplicates(from, to, id) {
	await sendOperation(from, { operation: 'insert', table: 'test', records: [{ id, name: id }] });
	await waitForCondition(
		async (signal) => {
			const result = await sendOperation(
				to,
				{ operation: 'search_by_id', table: 'test', ids: [id], get_attributes: ['id'] },
				{ signal }
			);
			return Array.isArray(result) && result.length === 1;
		},
		{ timeoutMs: REPLICATION_TIMEOUT_MS, pollMs: POLL_MS, description: `record ${id} to replicate to ${to.hostname}` }
	);
}

suite('W1 connection-truth residuals (harper-pro#431)', { timeout: 420000 }, (ctx) => {
	// Every SIGSTOP is registered here so a failed assertion can never leave a frozen process behind for
	// teardownHarper to wait on.
	const frozen = new Set();
	async function freeze(node) {
		const pid = await readNodePid(node);
		ok(pid, `expected a pid file for ${node.hostname}`);
		process.kill(pid, 'SIGSTOP');
		frozen.add(pid);
		return pid;
	}
	function thaw(pid) {
		if (!frozen.delete(pid)) return;
		try {
			process.kill(pid, 'SIGCONT');
		} catch {
			/* already gone */
		}
	}

	before(async () => {
		// The subscriber carries the worker-kill fixture; the peer is a plain node.
		const peerCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const subscriberCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await startHarper(peerCtx, nodeStartOptions(peerCtx.harper));
		const subscriberOptions = nodeStartOptions(subscriberCtx.harper);
		// One HTTP worker, so the thread that answers the kill endpoint is provably the thread that owns the
		// subscription — the test asserts that identity rather than assuming it.
		subscriberOptions.config.threads = { count: 1 };
		await setupHarperWithFixture(subscriberCtx, join(import.meta.dirname, 'fixture-worker-exit'), {
			...subscriberOptions,
			env: { HARPER_TEST_KILL_HTTP_WORKER: '1' },
		});
		ctx.nodes = [peerCtx.harper, subscriberCtx.harper];
		await Promise.all(
			ctx.nodes.map((node) =>
				sendOperation(node, {
					operation: 'create_table',
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
		for (const pid of Array.from(frozen)) thaw(pid);
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('R1: a dead owning worker corrects connection truth within two reconcile ticks', async () => {
		const [peer, subscriber] = ctx.nodes;
		await ensureSubscribed(subscriber, peer);
		await assertReplicates(peer, subscriber, 'r1-before');

		// Freeze the peer rather than killing it: a kill closes the socket, and the close handler would
		// write DOWN by itself, which is the path that already worked. Frozen, the peer answers nothing and
		// never closes, so the subscriber's buffer is left holding CONNECTED with liveness that stays fresh
		// for the whole LIVENESS_STALE_MS window — exactly the state a dead worker used to leave behind.
		const peerPid = await freeze(peer);
		try {
			const beforeKill = peerSocket(await clusterStatus(subscriber), peer.hostname);
			equal(
				beforeKill?.connected,
				true,
				'precondition: the subscriber must still read the frozen peer as connected, or the ' +
					'assertion below would pass without the worker-exit stamp'
			);

			// Kill the HTTP worker thread that owns the subscription. It dies without running its
			// connection's close handler, so nothing worker-side can record the disconnect — the state
			// only the main thread can correct.
			const killed = await killOwningWorker(subscriber);
			equal(killed.armed, true, 'the worker-kill fixture must be armed');
			equal(killed.threadId, beforeKill.threadId, 'the killed worker must be the one that owns the subscription');

			const corrected = await pollPeerSocket(
				subscriber,
				peer.hostname,
				(socket) => socket?.connected === false && socket?.lastConnectionError?.code === WORKER_EXIT_ERROR_CODE,
				{
					timeoutMs: TRUTH_CORRECTION_BOUND_MS,
					description:
						`${subscriber.hostname} to report its subscription to ${peer.hostname} down with the ` +
						`worker-exit code ${WORKER_EXIT_ERROR_CODE} within ${TRUTH_CORRECTION_BOUND_MS}ms`,
				}
			);
			equal(corrected.connected, false);
			equal(corrected.lastConnectionError.code, WORKER_EXIT_ERROR_CODE);
		} finally {
			thaw(peerPid);
		}

		// A live successor must flip the link back: the stamp is a correction, not a latch.
		await pollPeerSocket(subscriber, peer.hostname, (socket) => socket?.connected === true, {
			timeoutMs: CONNECT_TIMEOUT_MS,
			description: `${subscriber.hostname} to reconnect to ${peer.hostname} after it resumes`,
		});
		await assertReplicates(peer, subscriber, 'r1-after');
	});

	test('R2: a re-added node starts from zeroed truth, not the removed membership state', async () => {
		const [peer, subscriber] = ctx.nodes;
		await ensureSubscribed(subscriber, peer);
		// Prove the link is genuinely established before tearing it down. `connected` alone is not enough
		// here: the state this test asserts about is written by the close of a REAL connection, so a link
		// that only reads connected would take the teardown path without ever stamping, and the assertion
		// below would pass for the wrong reason.
		await assertReplicates(peer, subscriber, 'r2-before');

		// unsubscribe() closes with 1008 and the close handler stamps that as the link's last error. The
		// buffer is process-scoped and keyed by (database, peer), so without the reset the re-added
		// membership inherits an error it never suffered — and the main-thread reset alone does not fix it,
		// because the owning worker's close writes 1008 *after* the main thread has zeroed.
		await sendOperation(subscriber, { operation: 'remove_node', hostname: peer.hostname });
		await pollPeerSocket(subscriber, peer.hostname, (socket) => socket === undefined, {
			timeoutMs: CONNECT_TIMEOUT_MS,
			description: `${subscriber.hostname} to drop its tracking of ${peer.hostname}`,
		});

		await addPeer(subscriber, peer);
		const reAdded = await pollPeerSocket(subscriber, peer.hostname, (socket) => socket?.connected === true, {
			timeoutMs: CONNECT_TIMEOUT_MS,
			description: `${subscriber.hostname} to reconnect to the re-added ${peer.hostname}`,
		});

		equal(
			reAdded.lastConnectionError,
			undefined,
			'a re-added node must not inherit the removed membership’s close code'
		);
		// Zeroed truth must not be zeroed capability: the re-added subscription still carries data, which is
		// also what proves the confirmation watcher survived the remove/re-add. Only this node's own
		// subscription is asserted — the peer re-establishes its direction independently of anything here.
		await assertReplicates(peer, subscriber, 'r2-after-readd');
	});

	test('R3: cluster_status carries the latency and back-pressure the reconcile copies off shared memory', async () => {
		const [peer, subscriber] = ctx.nodes;
		await ensureSubscribed(subscriber, peer);
		await assertReplicates(peer, subscriber, 'r3-traffic');

		// The copy happens on the 5s reconcile tick, so give it at least one full tick to run after the link
		// has settled and a pong has landed.
		const socket = await pollPeerSocket(
			subscriber,
			peer.hostname,
			(candidate) => candidate?.connected === true && typeof candidate.backPressureRatio === 'number',
			{
				timeoutMs: CONNECT_TIMEOUT_MS,
				description: `${subscriber.hostname} to publish the copied link metrics for ${peer.hostname}`,
			}
		);

		ok(Number.isFinite(socket.latency) && socket.latency > 0, `expected a positive latency, got ${socket.latency}`);
		ok(
			socket.backPressureRatio >= 0 && socket.backPressureRatio <= 1,
			`expected a back-pressure ratio in [0,1], got ${socket.backPressureRatio}`
		);
		// backPressurePercent is read straight from the shared slot at cluster_status time; backPressure is
		// the copy the reconcile put on the main-thread entry. Agreement is what makes the bridge trustworthy.
		ok(
			Math.abs(socket.backPressureRatio * 100 - socket.backPressurePercent) < 1e-9,
			`expected the copied back-pressure (${socket.backPressureRatio * 100}%) to agree with the shared slot ` +
				`(${socket.backPressurePercent}%)`
		);
	});

	test('R4: a wedge-reconcile fire is classified against truth and counted in cluster_status', async () => {
		const [peer, subscriber] = ctx.nodes;
		const before = await ensureSubscribed(subscriber, peer);

		// Kill the peer so the subscriber sees a real close: the entry goes connected:false and the truth
		// goes down with a transport close code. Holding it down past WEDGE_RECONCILE_THRESHOLD_MS makes the
		// main-thread wedge-reconcile net fire while truth already reads down — a redundant fire.
		await killHarper({ harper: peer });
		await pollPeerSocket(subscriber, peer.hostname, (socket) => socket?.connected === false, {
			timeoutMs: CONNECT_TIMEOUT_MS,
			description: `${subscriber.hostname} to observe the killed ${peer.hostname} as down`,
		});

		// Relative to a baseline: earlier tests in this suite can leave their own fires on the same link, and
		// what R4 asserts is that THIS fire — one that happened while truth already read down — landed in the
		// redundant bucket.
		const baseline = before?.recoveryFires?.['wedge-reconcile'] ?? { redundant: 0, loadBearing: 0 };
		const fired = await pollPeerSocket(
			subscriber,
			peer.hostname,
			(socket) => socket?.recoveryFires?.['wedge-reconcile']?.redundant > baseline.redundant,
			{
				timeoutMs: WEDGE_FIRE_WAIT_MS,
				description: `${subscriber.hostname} to report a redundant wedge-reconcile fire for ${peer.hostname}`,
			}
		);
		equal(
			fired.recoveryFires['wedge-reconcile'].loadBearing,
			baseline.loadBearing,
			'truth already read down, so this fire must not have been counted load-bearing'
		);

		const log = await readLog(subscriber);
		ok(
			log.includes('fire={mechanism: wedge-reconcile, class: redundant'),
			'expected the wedge-reconcile fire log line to carry its classification'
		);

		ctx.nodes[0] = (await startHarper({ harper: peer }, nodeStartOptions(peer))).harper;
		await pollPeerSocket(subscriber, ctx.nodes[0].hostname, (socket) => socket?.connected === true, {
			timeoutMs: RECONNECT_AFTER_RESTART_MS,
			description: `${subscriber.hostname} to reconnect after ${peer.hostname} restarts`,
		});
		// Counters are telemetry: they must not have changed whether or how the link recovers.
		await assertReplicates(ctx.nodes[0], subscriber, 'r4-after-restart');
	});
});
