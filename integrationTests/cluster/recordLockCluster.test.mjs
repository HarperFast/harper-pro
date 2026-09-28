/**
 * Cluster-wide record locks over delegations (harper-pro#438, W9 Phase 1 of harper#483).
 *
 * What only real nodes can prove: that a delegation request reaches a key's home over the real
 * replication connections and comes back granted; that lock()+increment across three nodes stays
 * exclusive AND fresh (the N admitted increments are exactly 1..N and every node converges to N —
 * harper#2613's successor-freshness lineage plus this transport's `lockBarrier` proof, harper#2625);
 * that a key held on one node hands over to another on release, through recall; that a
 * lock is exclusive across nodes while held; that a stale holder is fenced; and that a peer without
 * the delegation-level `recordLocks` capability is not a ring member and fails a cluster lock closed.
 *
 * Most suites run one http worker per node (`threads.count: 1`) to keep the cross-node behavior the
 * focus. The final suite runs one node at `threads.count: 3` beside a single-worker peer, and proves
 * two things a lone node cannot: that a lock() served on a non-owner worker relays its admission to the
 * coordinating one rather than answering 503, and that exclusion still holds across the node boundary
 * while it does (harper-pro#852). It does NOT prove that a cross-node recall fenced a RELAYED handle in
 * particular — which worker serves any given REST increment is routing-dependent, so the recall may
 * only ever reach a handle the coordinating worker held itself. That end-to-end fence is an open
 * coverage gap, not something these tests establish.
 *
 * The home map is now OPERATOR-AGREED (harper-pro#825): nothing locks until `bootstrapHomeMap` below
 * stages generation 1 naming every node, then activates it — `homeMap()` returns `undefined` and every
 * cluster lock fails closed until that completes. `HARPER_TEST_RECORD_LOCK_MIN_DRAIN_BACKSTOP_MS=0`
 * lifts the (deliberately small — 2s default) backstop between stage and activate; the REAL safety
 * margin (`DELEGATION_LEASE_MS + skew`, several minutes) is the operator's own external wait, which
 * nothing in the code enforces — see RECORD_LOCK_HOMES_DESIGN.md.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { sendOperation, waitForCondition } from './clusterShared.mjs';
import {
	DB,
	CONVERGE_TIMEOUT_MS,
	bootstrapHomeMap,
	call,
	clusterStatusOf,
	connectMesh,
	controlEntries,
	counter,
	putCounter,
	startNode,
	stopNode,
	waitForCounter,
	waitForRing,
} from './recordLockShared.mjs';

suite('cluster record locks: three-node full mesh', { timeout: 420_000 }, (ctx) => {
	const contexts = [];
	let nodes;

	before(async () => {
		// allSettled, not all: one failed start must not drop the contexts of the nodes that did come up,
		// or `after` sees an empty list and leaks their processes and ports into the rest of the run.
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

	test("cluster_status reports each database's lock coordinator and the agreed ring", async () => {
		const rings = [];
		for (const node of nodes) {
			const status = await clusterStatusOf(node);
			const locks = status.recordLocks?.[DB];
			assert.ok(locks, `${node.hostname} reports no recordLocks for ${DB}: ${JSON.stringify(status.recordLocks)}`);
			assert.equal(typeof locks.ownerThreadId, 'number', 'the single http worker coordinates the database');
			assert.equal(locks.granted, 0);
			assert.equal(locks.admitted, 0);
			assert.equal(locks.droppedOffOwner, 0, 'nothing is applied off the coordinating worker');
			rings.push(JSON.stringify(locks.members));
		}
		// The whole point of deriving the home from an agreed set: every node computes the same ring.
		assert.equal(new Set(rings).size, 1, `nodes disagree about the ring: ${rings.join(' | ')}`);
	});

	test('N concurrent lock()+increment spread across the nodes stay exclusive and converge', async () => {
		const id = 'counter-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		const N = 24;
		const results = await Promise.all(
			Array.from({ length: N }, (_, i) => call(nodes[i % nodes.length], 'LockedIncrement/', { id }))
		);
		const failed = results.filter((result) => result.status !== 200);
		assert.deepEqual(failed, [], `every increment must succeed: ${JSON.stringify(failed)}`);
		const seen = results.map((result) => result.body.n);
		// Exclusion plus successor freshness (harper#2613 + this transport's barrier): every admitted
		// critical section read its predecessor's write, so the N increments are exactly 1..N. A collision
		// here is a freshness failure, not noise.
		assert.deepEqual(
			[...seen].sort((a, b) => a - b),
			Array.from({ length: N }, (_, i) => i + 1),
			`admitted increments are not exactly 1..${N}: ${seen}`
		);
		const finalValues = await waitForCondition(
			async (signal) => {
				const values = await Promise.all(nodes.map((node) => counter(node, id, signal).then((record) => record?.n)));
				return values.every((n) => n === values[0]) ? values : undefined;
			},
			{ timeoutMs: CONVERGE_TIMEOUT_MS, description: `Counter/${id} to converge to the same value on every node` }
		);
		// The proof that freshness ran, not only that the numbers came out: at least one handoff crossed
		// nodes, so at least one lockBarrier was requested and observed applied, and nothing poisoned.
		let barriersApplied = 0;
		for (const node of nodes) {
			const locks = (await clusterStatusOf(node)).recordLocks?.[DB];
			barriersApplied += locks?.freshness?.applied ?? 0;
			assert.deepEqual(locks?.poisoned ?? [], [], `${node.hostname} reports a replication hole: ${locks?.poisoned}`);
		}
		assert.ok(barriersApplied >= 1, 'no successor-freshness barrier was applied during the cross-node handoffs');
		assert.ok(
			finalValues.every((n) => n === N),
			`nodes did not converge to ${N}: ${finalValues}`
		);
	});

	test('repeat locks from one node cost no release entries: the delegation is retained', async () => {
		const id = 'repeat-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		const before = (await controlEntries(nodes[0])).length;
		for (let i = 0; i < 10; i++) {
			const result = await call(nodes[0], 'LockedIncrement/', { id });
			assert.equal(result.status, 200, JSON.stringify(result.body));
		}
		await delay(500);
		// Releasing the application lock does not release the delegation, so ten locks on one node write
		// nothing to the log; a release entry appears only when another node takes the key.
		assert.equal((await controlEntries(nodes[0])).length, before, 'no release per repeat lock');
		await waitForCounter(nodes, id, 10);
	});

	test("a plain write during a hold wins by LWW over the holder's write, and a write after the lease is 409", async () => {
		const id = 'fence-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		const lease = 2_000;
		const held = await call(nodes[0], 'LockHold/', { id, lease, timeout: 5_000 });
		assert.equal(held.status, 200, JSON.stringify(held.body));
		const { token } = held.body;
		// Plain writes are never gated: this lands immediately, stamped now, later than the holder's tsR.
		await putCounter(nodes[1], id, 100);
		const written = await call(nodes[0], 'LockWrite/', { token, n: 1 });
		assert.equal(written.status, 200, JSON.stringify(written.body));
		assert.deepEqual(
			await waitForCounter(nodes, id, 100),
			nodes.map(() => 100)
		);
		await delay(lease + 500);
		const stale = await call(nodes[0], 'LockWrite/', { token, n: 2 });
		assert.equal(stale.status, 409, `a write after the lease must be refused: ${JSON.stringify(stale.body)}`);
		assert.deepEqual(
			await waitForCounter(nodes, id, 100),
			nodes.map(() => 100)
		);
		await call(nodes[0], 'LockRelease/', { token });
	});

	test('a lock is exclusive across nodes while held, and hands over through recall on release', async () => {
		const id = 'exclusive-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		const held = await call(nodes[0], 'LockHold/', { id, lease: 20_000, timeout: 5_000 });
		assert.equal(held.status, 200, JSON.stringify(held.body));
		const contended = await call(nodes[1], 'LockHold/', { id, lease: 5_000, timeout: 1_500 });
		assert.equal(contended.status, 423, `a second node must wait, then time out: ${JSON.stringify(contended.body)}`);
		await call(nodes[0], 'LockRelease/', { token: held.body.token });
		const after = await call(nodes[2], 'LockHold/', { id, lease: 5_000, timeout: 10_000 });
		assert.equal(after.status, 200, `after release a third node acquires: ${JSON.stringify(after.body)}`);
		// The handoff is what writes a release: the recalled delegate surrenders on the replicated log.
		await waitForCondition(
			async (signal) =>
				(await controlEntries(nodes[0], signal)).some((entry) => entry.type === 'lockRelease' && entry.nodeId === 0),
			{ timeoutMs: 30_000, description: 'the recalled node to have written its release' }
		);
		await call(nodes[2], 'LockRelease/', { token: after.body.token });
	});

	// A crashed delegate holds its keys for up to DELEGATION_LEASE_MS (six minutes) before its home
	// re-grants them, which does not fit a test; whether that lease is configurable is an open
	// question on harper#2498. The property itself — a home never re-grants before the delegate's
	// deadline plus skew, on independent clocks — is asserted in core's coordinator unit suite.
	test.skip('a holder that crashes releases its key to a waiter once its delegation has run out', () => {});
});

suite('cluster record locks: a peer not named in the operator-agreed home map', { timeout: 300_000 }, (ctx) => {
	let currentCtx;
	let excludedCtx;
	let current;
	let excluded;

	before(async () => {
		// allSettled so a single failed start does not orphan the node that did come up.
		const started = await Promise.allSettled([startNode(ctx.name), startNode(ctx.name)]);
		[currentCtx, excludedCtx] = started.map((result) => (result.status === 'fulfilled' ? result.value : undefined));
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		current = currentCtx.harper;
		excluded = excludedCtx.harper;
		await connectMesh([current, excluded]);
		// The operator names only `current` in the home map — `excluded` is a real, connected, mesh
		// member that the operator has simply not (yet) included in cluster record locks for this
		// database. Never staged or activated on `excluded` at all.
		await bootstrapHomeMap([current]);
	});

	after(async () => {
		await stopNode(currentCtx);
		await stopNode(excludedCtx);
	});

	test('the excluded peer is not a ring member, so the named node homes every key itself', async () => {
		const status = await clusterStatusOf(current);
		const members = status.recordLocks?.[DB]?.members;
		assert.ok(
			Array.isArray(members) && members.length === 1,
			`ring should be this node alone: ${JSON.stringify(members)}`
		);
		// And so a cluster lock here is served with no request to the peer at all.
		const id = 'mixed-' + Date.now();
		const clusterScoped = await call(current, 'LockHold/', { id, timeout: 2_000 });
		assert.equal(clusterScoped.status, 200, JSON.stringify(clusterScoped.body));
		await call(current, 'LockRelease/', { token: clusterScoped.body.token });
		assert.deepEqual(await controlEntries(current), [], 'a retained delegation writes nothing to the log');
	});

	test('the excluded peer fails its own cluster lock closed — no active generation at all — and data still replicates both ways', async () => {
		const id = 'gated-' + Date.now();
		// `excluded` was never staged or activated: its homeMap() has no active generation, so it fails
		// every cluster lock closed rather than guessing a ring of its own. Fail closed, not a quiet
		// second arbiter — the same property the old capability-derived ring used to provide, now from
		// the operator's own choice of homes[] instead of a wire-advertised level.
		const excludedLock = await call(excluded, 'LockHold/', { id, lease: 2_000, timeout: 2_000 });
		assert.equal(
			excludedLock.status,
			503,
			`a node with no active generation must fail a cluster lock closed: ${JSON.stringify(excludedLock.body)}`
		);
		await putCounter(excluded, id, 7);
		await waitForCounter([current, excluded], id, 7);
		await putCounter(current, id + '-back', 8);
		await waitForCounter([current, excluded], id + '-back', 8);
	});
});

suite('cluster record locks: the §4.3 stage/activate transition', { timeout: 300_000 }, (ctx) => {
	const contexts = [];
	let nodes;
	let homes;

	before(async () => {
		const started = await Promise.allSettled([startNode(ctx.name), startNode(ctx.name)]);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		nodes = contexts.map((c) => c.harper);
		await connectMesh(nodes);
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
	});

	test('a database has no active generation, and every cluster lock fails closed, until activation', async () => {
		for (const node of nodes) {
			const status = await clusterStatusOf(node);
			assert.equal(status.recordLocks?.[DB]?.members, undefined, `${node.hostname} must report no home map yet`);
		}
		const id = 'pre-bootstrap-' + Date.now();
		const early = await call(nodes[0], 'LockHold/', { id, timeout: 2_000 });
		assert.equal(early.status, 503, `no active generation yet: ${JSON.stringify(early.body)}`);
	});

	test('staging retracts any active generation immediately — no window where a lock succeeds mid-transition', async () => {
		homes = await bootstrapHomeMap(nodes);
		await waitForRing(nodes, nodes.length);
		const id = 'retract-' + Date.now();
		const before = await call(nodes[0], 'LockHold/', { id, timeout: 2_000 });
		assert.equal(before.status, 200, JSON.stringify(before.body));
		await call(nodes[0], 'LockRelease/', { token: before.body.token });
		// Re-stage the SAME generation content as a new, higher generation — the content does not
		// matter here, only that staging happens and is observed to retract `active` before any
		// activate call: the row on `nodes[0]` goes from "active g1" straight to "staged g2, no
		// active" in one durable write.
		await sendOperation(nodes[0], {
			operation: 'record_lock_stage_generation',
			database: DB,
			generation: 2,
			homes,
			quiesce: homes,
			authorization: nodes[0].admin,
		});
		const duringTransition = await call(nodes[0], 'LockHold/', { id, timeout: 2_000 });
		assert.equal(
			duringTransition.status,
			503,
			`staged-but-not-active must fail closed, not keep granting under the old generation: ${JSON.stringify(duringTransition.body)}`
		);
		// Bring every node to generation 2 so subsequent tests in this file (if any ran after this one)
		// and teardown are not left with a permanently-diverged, half-transitioned cluster.
		for (const node of nodes)
			if (node !== nodes[0])
				await sendOperation(node, {
					operation: 'record_lock_stage_generation',
					database: DB,
					generation: 2,
					homes,
					quiesce: homes,
					authorization: node.admin,
				});
		for (const node of nodes)
			await sendOperation(node, {
				operation: 'record_lock_activate_generation',
				database: DB,
				generation: 2,
				homes,
				authorization: node.admin,
			});
		await waitForRing(nodes, nodes.length);
		const after = await call(nodes[0], 'LockHold/', { id, timeout: 2_000 });
		assert.equal(after.status, 200, `generation 2 active: ${JSON.stringify(after.body)}`);
		await call(nodes[0], 'LockRelease/', { token: after.body.token });
	});

	test('activation is idempotent, and refuses a generation that does not match what is staged', async () => {
		const repeat = await sendOperation(nodes[0], {
			operation: 'record_lock_activate_generation',
			database: DB,
			generation: 2,
			homes,
			authorization: nodes[0].admin,
		});
		assert.equal(repeat.active.generation, 2, 'idempotent re-activation of the current generation');
		const response = await fetch(nodes[0].operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'record_lock_activate_generation',
				database: DB,
				generation: 3,
				homes,
				authorization: nodes[0].admin,
			}),
		});
		assert.equal(response.status, 409, 'no generation 3 was ever staged');
	});
});

suite('cluster record locks at threads.count > 1 (harper-pro#852)', { timeout: 420_000 }, (ctx) => {
	const contexts = [];
	let multi; // one node running several http workers
	let peer; // a single-worker peer, so a cross-node recall fences a relayed handle on a non-owner worker
	let nodes;

	before(async () => {
		// `multi` runs 3 http workers: a cluster lock() served on any of them must succeed, the ones that
		// do not coordinate `data` relaying to the one that does. `peer` gives a real cross-node handoff,
		// the path a single node cannot exercise (no peer to recall a relayed hold).
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

	test('a cluster lock() served on a non-owner worker relays to the coordinating one', async () => {
		// `lock_probe` is a registered operation, so the ops-API dispatcher routes each call to one of
		// `multi`'s http workers — often NOT the one coordinating `data`. Every call must still take the
		// lock: before harper-pro#852 a call routed to a non-owner worker answered 503. The reply names
		// the serving thread, so we can prove a non-owner served one (only possible via the relay).
		const ownerThreadId = (await clusterStatusOf(multi)).recordLocks?.[DB]?.ownerThreadId;
		// Which worker the dispatcher picks is its own business, so a fixed batch could in principle land
		// entirely on the owner and prove nothing. Keep issuing batches until a non-owner has served one,
		// which is what makes the assertion below about the relay rather than about routing luck.
		const probes = [];
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
				probes.push(probe);
				threads.add(probe.threadId);
			}
		}
		assert.ok(
			probes.every((p) => p.locked === true),
			`every probe must take the lock on whatever worker served it: ${JSON.stringify(probes)}`
		);
		const offOwner = [...threads].filter((t) => t !== ownerThreadId);
		assert.ok(
			offOwner.length >= 1,
			`after ${probes.length} probes the dispatcher never left the coordinating worker (${ownerThreadId}); threads seen: ${[...threads]}`
		);
		const locks = (await clusterStatusOf(multi)).recordLocks?.[DB];
		assert.ok(
			(locks?.relayedAdmissions ?? 0) >= 1,
			`a non-owner worker served a lock but none relayed: ${JSON.stringify(locks)}`
		);
	});

	test('cross-node increments stay exclusive with the multi-worker node relaying', async () => {
		// The discriminating test: a single node's native key lock alone would serialize its own workers,
		// so exclusion must be proven across the node boundary. N increments from `multi` (spread across
		// its 3 workers, each relaying to the owner) interleaved with N from `peer` must total exactly
		// 1..2N with no collision — a broken relay would either 503 (a failed increment) or admit two of
		// `multi`'s workers at once against `peer` (a duplicated value).
		const id = 'xnode-' + Date.now();
		await putCounter(multi, id, 0);
		await waitForCounter(nodes, id, 0);
		const N = 16;
		const results = await Promise.all(
			Array.from({ length: 2 * N }, (_, i) => call(i % 2 === 0 ? multi : peer, 'LockedIncrement/', { id }))
		);
		const failed = results.filter((r) => r.status !== 200);
		assert.deepEqual(failed, [], `every increment must succeed on every node and worker: ${JSON.stringify(failed)}`);
		const seen = results.map((r) => r.body.n).sort((a, b) => a - b);
		assert.deepEqual(
			seen,
			Array.from({ length: 2 * N }, (_, i) => i + 1),
			`admitted increments are not exactly 1..${2 * N}: ${seen}`
		);
		const finalValues = await waitForCounter(nodes, id, 2 * N);
		assert.ok(
			finalValues.every((n) => n === 2 * N),
			`nodes did not converge to ${2 * N}: ${finalValues}`
		);
		// Note: that `multi`'s off-owner workers relay (rather than 503) is proven deterministically by
		// the preceding test's 24 ops-API probes. We do not assert a relayedAdmissions delta here: the
		// REST client can keep-alive-pin all of `multi`'s increments to a single worker, so whether any
		// land off the owner is routing-dependent. Exclusion across the node boundary is the real proof.
	});
});
