/**
 * A restarted record-lock home ends its grant quarantine by recall instead of waiting out the
 * delegation lease (harper#3254). What only real nodes can prove:
 *
 * - with every ring member reachable, a home that restarts grants on its keys within seconds, not the
 *   ~365 s of `DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS` (the fails-on-base case);
 * - a member still holding a live delegation from the previous incarnation drains and releases it
 *   before the restarted home grants that key to another node, and the two holds never overlap;
 * - a member that rejects the recall operation (an older build, stood in for by
 *   `HARPER_TEST_RECORD_LOCK_OMIT_INCARNATION_RECALL`) or is unreachable keeps the timer in force;
 * - a home running several http workers answers and recalls through the owner relay.
 *
 * The home of a key is found by probing (`keyHomedOn`), never by re-implementing the ring hash here.
 * A restart is complete only once `cluster_status` reports a higher coordination incarnation: the
 * outgoing process keeps answering the operations socket for a moment after the new pid appears.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { restartNode, sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';
import {
	DB,
	bootstrapHomeMap,
	call,
	clusterStatusOf,
	connectMesh,
	controlEntries,
	putCounter,
	startNode,
	stopNode,
	waitForCounter,
	waitForMesh,
	waitForRing,
} from './recordLockShared.mjs';

/** Far below the timer (365 s) and above a loaded CI runner's restart plus reconnect. */
const RECALL_BOUND_MS = 90_000;
/** How long a quarantined home is watched to show the timer is still in force. */
const TIMER_WATCH_MS = 15_000;

async function lockStats(node, signal) {
	return (await clusterStatusOf(node, signal)).recordLocks?.[DB];
}

/**
 * A fresh key homed on `target`: the node whose `granted` count rises when `from` locks it. A probe
 * refused with 503 (the key's home is quarantined) is skipped rather than failed.
 */
async function keyHomedOn(nodes, target, from, prefix) {
	for (let i = 0; i < 64; i++) {
		const id = `${prefix}-${Date.now()}-${i}`;
		await putCounter(from, id, 0);
		await waitForCounter(nodes, id, 0);
		const before = await Promise.all(nodes.map((node) => lockStats(node).then((stats) => stats?.granted ?? 0)));
		const held = await call(from, 'LockHold/', { id, lease: 5_000, timeout: 10_000 });
		if (held.status === 503) continue;
		assert.equal(held.status, 200, JSON.stringify(held.body));
		await call(from, 'LockRelease/', { token: held.body.token });
		const after = await Promise.all(nodes.map((node) => lockStats(node).then((stats) => stats?.granted ?? 0)));
		const home = nodes.findIndex((_, index) => after[index] > before[index]);
		if (home >= 0 && nodes[home] === target) return id;
	}
	throw new Error(`no key homed on ${target.hostname} found in 64 probes`);
}

/**
 * Restart `node` and return once its NEW incarnation answers `cluster_status` and, when `mesh` is
 * given, every node of it is connected to every other again: a lock whose freshness barrier must
 * arrive over the restarted node's stream cannot complete before that stream is back.
 */
async function restartHome(node, mesh) {
	const previous = (await lockStats(node)).restartRecall?.incarnation ?? 0;
	assert.ok(previous > 0, `${node.hostname} coordinates ${DB} before the restart`);
	await restartNode(node);
	const stats = await waitForCondition(
		async (signal) => {
			const current = await lockStats(node, signal).catch(() => undefined);
			return current?.restartRecall?.incarnation > previous ? current : undefined;
		},
		{
			timeoutMs: 120_000,
			pollMs: 500,
			description: `${node.hostname} to answer cluster_status from an incarnation above ${previous}`,
		}
	);
	if (mesh) await waitForMesh(mesh);
	return stats;
}

function waitForAttested(home) {
	return waitForCondition(
		async (signal) => {
			const stats = await lockStats(home, signal);
			return stats?.restartRecall?.state === 'attested' && stats.unprovenMs === 0 ? stats : undefined;
		},
		{ timeoutMs: RECALL_BOUND_MS, pollMs: 500, description: `${home.hostname} to attest its restart recall` }
	);
}

suite('record locks: a restarted home ends its quarantine by recall (harper#3254)', { timeout: 600_000 }, (ctx) => {
	const contexts = [];
	let nodes;

	before(async () => {
		const started = await Promise.allSettled([startNode(ctx.name), startNode(ctx.name), startNode(ctx.name)]);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		nodes = contexts.map((c) => c.harper);
		await connectMesh(nodes);
		await bootstrapHomeMap(nodes);
		await waitForRing(nodes, nodes.length);
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
	});

	test('with every member reachable, grants on the restarted home resume within seconds, not ~365 s', async () => {
		const [home, delegate, other] = nodes;
		// A retained delegation on another node from the incarnation about to die: the recall has
		// something real to drain, and the home must not grant that key elsewhere until it is released.
		const retained = await keyHomedOn(nodes, home, delegate, 'retained');
		const fresh = await keyHomedOn(nodes, home, home, 'fresh');
		const restartedAt = Date.now();
		const restarted = await restartHome(home, nodes);
		await waitForRing(nodes, nodes.length);
		const attested = await waitForAttested(home);
		assert.equal(attested.restartRecall.incarnation, restarted.restartRecall.incarnation);

		const granted = await call(other, 'LockHold/', { id: retained, lease: 5_000, timeout: 20_000 });
		assert.equal(granted.status, 200, `the recalled key is grantable: ${JSON.stringify(granted.body)}`);
		await call(other, 'LockRelease/', { token: granted.body.token });
		const own = await call(home, 'LockHold/', { id: fresh, lease: 5_000, timeout: 20_000 });
		assert.equal(own.status, 200, `the home grants to itself: ${JSON.stringify(own.body)}`);
		await call(home, 'LockRelease/', { token: own.body.token });
		const elapsed = Date.now() - restartedAt;
		assert.ok(elapsed < RECALL_BOUND_MS, `grants resumed ${elapsed}ms after the restart; the timer would be ~365 s`);
		// The delegate surrendered its old-incarnation delegation through the ordinary release entry.
		await waitForCondition(
			async (signal) =>
				(await controlEntries(delegate, signal)).some((entry) => entry.type === 'lockRelease' && entry.nodeId === 0),
			{ timeoutMs: 30_000, description: 'the delegate to have written its release' }
		);
	});

	test('a member holding a live delegation from the dead incarnation releases before the key goes elsewhere', async () => {
		const [home, holder, contender] = nodes;
		const id = await keyHomedOn(nodes, home, holder, 'held');
		const held = await call(holder, 'LockHold/', { id, lease: 60_000, timeout: 10_000 });
		assert.equal(held.status, 200, JSON.stringify(held.body));
		await restartHome(home, nodes);
		await waitForRing(nodes, nodes.length);
		// The recall cannot complete while the holder is inside its critical section, so the home must
		// still be quarantined and the contender must not get the key.
		const contended = await call(contender, 'LockHold/', { id, lease: 5_000, timeout: 5_000 });
		assert.notEqual(contended.status, 200, `a second holder was admitted: ${JSON.stringify(contended.body)}`);
		const during = await lockStats(home);
		assert.notEqual(during.restartRecall?.state, 'attested', JSON.stringify(during.restartRecall));
		const releasedAt = Date.now();
		await call(holder, 'LockRelease/', { token: held.body.token });
		await waitForAttested(home);
		const after = await call(contender, 'LockHold/', { id, lease: 5_000, timeout: 20_000 });
		assert.equal(after.status, 200, `after the release the contender acquires: ${JSON.stringify(after.body)}`);
		assert.ok(Date.now() >= releasedAt, 'the second hold started after the first ended');
		await call(contender, 'LockRelease/', { token: after.body.token });
	});
});

suite(
	'record locks: a member that cannot answer the recall keeps the timer (harper#3254)',
	{ timeout: 600_000 },
	(ctx) => {
		const contexts = [];
		let nodes;
		let oldPeerName;

		before(async () => {
			const started = await Promise.allSettled([
				startNode(ctx.name),
				startNode(ctx.name),
				// Stands in for a build that predates the recall operation: it rejects the operation as unknown.
				startNode(ctx.name, { HARPER_TEST_RECORD_LOCK_OMIT_INCARNATION_RECALL: '1' }),
			]);
			for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
			const failed = started.find((result) => result.status === 'rejected');
			if (failed) throw failed.reason;
			nodes = contexts.map((c) => c.harper);
			await connectMesh(nodes);
			await bootstrapHomeMap(nodes);
			await waitForRing(nodes, nodes.length);
			oldPeerName = (await clusterStatusOf(nodes[2])).node_name;
		});

		after(async () => {
			for (const c of contexts) await stopNode(c);
		});

		async function assertQuarantineHolds(home, requester, id, unanswered) {
			const until = Date.now() + TIMER_WATCH_MS;
			let observed;
			while (Date.now() < until) {
				const attempt = await call(requester, 'LockHold/', { id, lease: 2_000, timeout: 2_000 });
				assert.equal(attempt.status, 503, `the quarantine ended early: ${JSON.stringify(attempt.body)}`);
				assert.match(
					attempt.body?.title ?? JSON.stringify(attempt.body),
					/restarted and cannot grant|No agreed record lock home map|home map generation unknown/,
					`refused for the quarantine, or for the map a stopped member withholds: ${JSON.stringify(attempt.body)}`
				);
				observed = await lockStats(home);
				assert.notEqual(observed.restartRecall?.state, 'attested', JSON.stringify(observed.restartRecall));
				await delay(1_000);
			}
			assert.ok(observed.unprovenMs > 0, `the drain is not provable: ${JSON.stringify(observed)}`);
			if (unanswered)
				assert.ok(
					observed.restartRecall?.unanswered?.includes(unanswered),
					`${unanswered} is the member that did not answer: ${JSON.stringify(observed.restartRecall)}`
				);
		}

		test('a peer at the old level rejects the operation, and the home keeps the timer', async () => {
			const [home, requester] = nodes;
			// Probed from the home itself: a probe from `requester` would leave it a retained delegation that
			// serves its later locks locally, never consulting the restarted home at all.
			const id = await keyHomedOn(nodes, home, home, 'old-level');
			await restartHome(home, nodes);
			await waitForRing(nodes, nodes.length);
			await assertQuarantineHolds(home, requester, id, oldPeerName);
			const status = await lockStats(home);
			assert.match(status.restartRecall?.lastError ?? '', /\S/, 'the refusal is reported');
		});

		test('an unreachable member keeps the timer', async () => {
			// nodes[0] is still quarantined from the previous test, so the second node is the home here and
			// the probe runs from the home itself.
			const [requester, home] = nodes;
			const id = await keyHomedOn(nodes, home, home, 'unreachable');
			await stopNodeProcess(nodes[2]);
			await restartHome(home);
			await assertQuarantineHolds(home, requester, id);
		});
	}
);

suite('record locks: a restarted home at threads.count > 1 (harper#3254)', { timeout: 600_000 }, (ctx) => {
	const contexts = [];
	let multi;
	let peer;
	let nodes;

	before(async () => {
		const started = await Promise.allSettled([startNode(ctx.name, {}, 3), startNode(ctx.name, {}, 1)]);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		[multi, peer] = contexts.map((c) => c.harper);
		nodes = [multi, peer];
		await connectMesh(nodes);
		await bootstrapHomeMap(nodes);
		await waitForRing(nodes, nodes.length);
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
	});

	test('the multi-worker node answers a restarted peer through its owner relay, then recovers from its own restart', async () => {
		// `multi` holds a delegation from `peer`; peer's restart recall reaches whichever of multi's workers
		// holds the socket and is relayed to the coordinating one. Attestation on peer proves the answer.
		const fromPeer = await keyHomedOn(nodes, peer, multi, 'peer-homed');
		await restartHome(peer, nodes);
		await waitForRing(nodes, nodes.length);
		await waitForAttested(peer);
		const regained = await call(multi, 'LockHold/', { id: fromPeer, lease: 5_000, timeout: 20_000 });
		assert.equal(regained.status, 200, JSON.stringify(regained.body));
		await call(multi, 'LockRelease/', { token: regained.body.token });

		// Now the multi-worker node itself restarts: its new owner worker runs the round.
		const fromMulti = await keyHomedOn(nodes, multi, peer, 'multi-homed');
		const restartedAt = Date.now();
		await restartHome(multi, nodes);
		await waitForRing(nodes, nodes.length);
		await waitForAttested(multi);
		const granted = await call(peer, 'LockHold/', { id: fromMulti, lease: 5_000, timeout: 20_000 });
		assert.equal(granted.status, 200, JSON.stringify(granted.body));
		await call(peer, 'LockRelease/', { token: granted.body.token });
		assert.ok(Date.now() - restartedAt < RECALL_BOUND_MS);
		// Off-owner service is intact after the restart: keep probing until a non-owner worker served one.
		const ownerThreadId = (await lockStats(multi)).ownerThreadId;
		const threads = new Set();
		for (let round = 0; round < 8 && ![...threads].some((t) => t !== ownerThreadId); round++) {
			const batch = await Promise.all(
				Array.from({ length: 12 }, (_, i) =>
					sendOperation(multi, {
						operation: 'lock_probe',
						id: `probe-${Date.now()}-${round}-${i}`,
						authorization: multi.admin,
					})
				)
			);
			for (const probe of batch) {
				assert.equal(probe.locked, true, JSON.stringify(probe));
				threads.add(probe.threadId);
			}
		}
		assert.ok(
			[...threads].some((t) => t !== ownerThreadId),
			`no non-owner worker served a lock: ${[...threads]}`
		);
		assert.ok(
			((await lockStats(multi)).relayedAdmissions ?? 0) >= 1,
			'a relayed admission was served after the restart'
		);
	});
});
