/**
 * Cluster record locks stay available across a node restart (harper#3768, #2582, #3268;
 * record-locks.md §4.5). What only real nodes can prove:
 *
 * - a rolling process restart: a lock on a key the restarted node HELD (homed elsewhere) and on a key
 *   it HOMES succeeds inside `min(timeout, lease)` when that outlasts the downtime, where the keys it
 *   held used to be denied until the delegation lease ran out (~365 s);
 * - a rolling worker restart (the coordinating worker replaced, the process kept) does the same;
 * - holders never overlap across the restart: concurrent locked increments from every node sum to the
 *   serial result;
 * - `kill -9` is timed until the killed node's keys, held and homed, grant again;
 * - with a member down, the restarted node's round cannot complete: its quarantine stays unprovable and
 *   the keys it held stay held until that member returns (record-locks.md §4.5, "what stays unavoidable");
 * - a delegation request the transport delivers twice does not hold the key past the holder's release;
 * - a freshness barrier the restarting process or worker committed but never answered is asked again
 *   of its successor, and the successor lock reads the write made under the old delegation;
 * - a peer speaking the previous wire keeps the lease-expiry behavior on its side and nothing else breaks.
 *
 * A restart is complete only once `cluster_status` reports a higher coordination incarnation: the
 * outgoing process keeps answering the operations socket for a moment after the new pid appears.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readNodePid, restartNode, sendOperation, waitForCondition, waitForNewPid } from './clusterShared.mjs';
import {
	DB,
	bootstrapHomeMap,
	call,
	clusterStatusOf,
	connectMesh,
	counter,
	putCounter,
	restartStoppedNode,
	startNode,
	stopNode,
	waitForCounter,
	waitForMesh,
	waitForRing,
} from './recordLockShared.mjs';

/** The promise under test: a lock whose timeout and lease both outlast the downtime succeeds. */
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_LEASE_MS = 30_000;
/** Far below the delegation lease (365 s), which is what a held key used to cost after a restart. */
const AVAILABLE_BOUND_MS = 120_000;

async function lockStats(node, signal) {
	return (await clusterStatusOf(node, signal)).recordLocks?.[DB];
}

/**
 * A fresh key homed on `target`, found by probing from `from` so the hash is never re-implemented here.
 * `from` is left holding a (released) delegation for it, which is what the restart tests need.
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

function waitForIncarnationAbove(node, previous, description) {
	return waitForCondition(
		async (signal) => {
			const current = await lockStats(node, signal).catch(() => undefined);
			return current?.restartRecall?.incarnation > previous ? current : undefined;
		},
		{ timeoutMs: 120_000, pollMs: 500, description }
	);
}

async function incarnationOf(node) {
	const incarnation = (await lockStats(node)).restartRecall?.incarnation ?? 0;
	assert.ok(incarnation > 0, `${node.hostname} coordinates ${DB}`);
	return incarnation;
}

/** `restartNode`, then the new incarnation answering and (when `mesh` is given) the mesh reconnected. */
async function restartHome(node, mesh) {
	const previous = await incarnationOf(node);
	await restartNode(node);
	const stats = await waitForIncarnationAbove(
		node,
		previous,
		`${node.hostname} to come back above incarnation ${previous}`
	);
	if (mesh) await waitForMesh(mesh);
	return stats;
}

/** `a` and `b` see each other's `data` socket connected and agree on the ring, whatever else is down. */
function waitForPair(a, b) {
	return waitForCondition(
		async (signal) => {
			const statuses = await Promise.all([a, b].map((node) => clusterStatusOf(node, signal).catch(() => undefined)));
			const connected = statuses.every((status, index) =>
				status?.connections?.some(
					(connection) =>
						connection.database_sockets?.some((socket) => socket.database === DB && socket.connected) &&
						connection.name === statuses[1 - index]?.node_name
				)
			);
			return connected ? statuses : undefined;
		},
		{ timeoutMs: 90_000, description: 'the two live nodes to be connected' }
	);
}

/**
 * A locked increment from `node`, whose barrier the origin — started with
 * `HARPER_TEST_RECORD_LOCK_HOLD_BARRIER_ANSWER: holdFile` — commits and never answers
 * (`recordLockRpc.ts`); `restart` runs once the origin holds it.
 */
async function incrementAcrossHeldBarrier(node, id, holdFile, restart) {
	await rm(`${holdFile}.held`, { force: true });
	await writeFile(holdFile, '');
	try {
		const startedAt = Date.now();
		const incremented = call(
			node,
			'LockedIncrement/',
			{ id, timeout: LOCK_TIMEOUT_MS, lease: LOCK_LEASE_MS },
			AbortSignal.timeout(LOCK_TIMEOUT_MS + 10_000)
		);
		incremented.catch(() => {});
		await waitForCondition(
			() =>
				access(`${holdFile}.held`).then(
					() => true,
					() => undefined
				),
			{ timeoutMs: 30_000, pollMs: 50, description: 'the origin to commit a barrier it will not answer' }
		);
		await rm(holdFile, { force: true });
		await restart();
		return { ...(await incremented), elapsedMs: Date.now() - startedAt };
	} finally {
		await rm(holdFile, { force: true });
	}
}

const lockOnce = (node, id, timeout = LOCK_TIMEOUT_MS) =>
	call(node, 'LockOnce/', { id, timeout, lease: LOCK_LEASE_MS }, AbortSignal.timeout(timeout + 10_000));

/** Keep locking `id` from `node` until it succeeds; resolves with the elapsed time. */
async function timeUntilGranted(node, id, bound = AVAILABLE_BOUND_MS) {
	const startedAt = Date.now();
	let last;
	while (Date.now() - startedAt < bound) {
		last = await lockOnce(node, id, 5_000).catch((error) => ({ status: 0, body: String(error) }));
		if (last.status === 200) return Date.now() - startedAt;
		await delay(250);
	}
	throw new Error(`${id} did not grant from ${node.hostname} within ${bound}ms: ${JSON.stringify(last)}`);
}

suite('record locks across a node restart (harper#3768)', { timeout: 900_000 }, (ctx) => {
	const contexts = [];
	let nodes;
	let holdFile;
	let firstNodeEnv;

	before(async () => {
		holdFile = join(await mkdtemp(join(tmpdir(), 'record-lock-hold-')), 'hold');
		// The first node's transport delivers every delegation request twice (§5.2): the dedupe runs
		// under every lock this suite takes from it, not only in the test that checks it.
		firstNodeEnv = {
			HARPER_TEST_RECORD_LOCK_DUPLICATE_DELEGATE: '1',
			HARPER_TEST_RECORD_LOCK_HOLD_BARRIER_ANSWER: holdFile,
		};
		const started = await Promise.allSettled([
			startNode(ctx.name, firstNodeEnv),
			startNode(ctx.name),
			startNode(ctx.name),
		]);
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

	test('a rolling process restart: locks on the keys the node held and homes succeed inside the timeout', async () => {
		const [restarting, home, other] = nodes;
		// `held`: restarting holds a delegation from `home`. Before §4.5, `other`'s lock on it after the
		// restart was denied until the delegation lease ran out: the home recalled, the new incarnation
		// confirmed a recall for a token it never held, and nothing ever released it.
		const held = await keyHomedOn(nodes, home, restarting, 'held');
		// `homed`: a key the restarting node homes, which `other` holds a delegation for.
		const homed = await keyHomedOn(nodes, restarting, other, 'homed');
		const previous = await incarnationOf(restarting);
		const previousPid = await readNodePid(restarting);
		const restartedAt = Date.now();
		await sendOperation(restarting, { operation: 'restart' }).catch(() => {});
		// Issued while the node is going down, with the default-sized timeout and lease.
		const onHeld = lockOnce(other, held).then((result) => ({ ...result, atMs: Date.now() - restartedAt }));
		await waitForNewPid(restarting, previousPid);
		// Issued once the new process exists (its home is unreachable for less than the ride-through).
		const onHomed = lockOnce(home, homed).then((result) => ({ ...result, atMs: Date.now() - restartedAt }));
		const [heldResult, homedResult] = await Promise.all([onHeld, onHomed]);
		const elapsed = Date.now() - restartedAt;
		console.log(
			`rolling restart: the held key granted ${heldResult.atMs}ms and the homed key ${homedResult.atMs}ms after the restart was issued`
		);
		assert.equal(heldResult.status, 200, `the key the node held: ${JSON.stringify(heldResult.body)}`);
		assert.equal(homedResult.status, 200, `the key the node homes: ${JSON.stringify(homedResult.body)}`);
		assert.ok(elapsed < LOCK_TIMEOUT_MS, `both locks landed ${elapsed}ms after the restart was issued`);
		const stats = await waitForIncarnationAbove(restarting, previous, 'the restarted node to answer');
		assert.ok(
			stats.delegateEpoch >= stats.restartRecall.incarnation,
			`the epoch follows the incarnation: ${JSON.stringify(stats)}`
		);
		await waitForMesh(nodes);
		// The restarted node itself takes both keys again: its old grant for `held` was retired, so its
		// new request is a fresh grant, never a renewal of a dead epoch's authority.
		for (const id of [held, homed]) {
			const own = await lockOnce(restarting, id);
			assert.equal(own.status, 200, `${id} from the restarted node: ${JSON.stringify(own.body)}`);
		}
	});

	test('a barrier the restarting process committed but never answered is asked again of the new process', async () => {
		const [restarting, home, other] = nodes;
		const id = await keyHomedOn(nodes, home, restarting, 'unanswered');
		// Written under the restarting node's delegation: its successor's lineage names that node.
		const written = await call(restarting, 'LockedIncrement/', { id, timeout: LOCK_TIMEOUT_MS, lease: LOCK_LEASE_MS });
		assert.equal(written.status, 200, JSON.stringify(written.body));
		const retriedBefore = (await lockStats(other)).freshness?.retried ?? 0;
		const previous = await incarnationOf(restarting);
		const result = await incrementAcrossHeldBarrier(other, id, holdFile, () =>
			sendOperation(restarting, { operation: 'restart' }).catch(() => {})
		);
		// Back before asserting, so a failure here leaves the next test a whole cluster.
		await waitForIncarnationAbove(restarting, previous, 'the restarted node to answer');
		await waitForMesh(nodes);
		console.log(`held barrier, process restart: the successor locked ${result.elapsedMs}ms after asking`);
		assert.equal(result.status, 200, `the successor across the restart: ${JSON.stringify(result.body)}`);
		assert.equal(result.body.n, written.body.n + 1, 'the successor read the write made under the old delegation');
		const freshness = (await lockStats(other)).freshness;
		assert.ok(freshness?.retried > retriedBefore, `the barrier was asked again: ${JSON.stringify(freshness)}`);
	});

	test('holders never overlap across a restart, and the final values match a serial run', async () => {
		const [restarting, home, other] = nodes;
		const keys = [
			await keyHomedOn(nodes, home, restarting, 'inc-held'),
			await keyHomedOn(nodes, restarting, other, 'inc-homed'),
		];
		const successes = new Map(keys.map((id) => [id, 0]));
		const failures = [];
		let stop = false;
		const workers = [];
		for (const node of nodes)
			for (const id of keys)
				workers.push(
					(async () => {
						while (!stop) {
							const result = await call(
								node,
								'LockedIncrement/',
								{ id, timeout: LOCK_TIMEOUT_MS, lease: LOCK_LEASE_MS },
								AbortSignal.timeout(LOCK_TIMEOUT_MS + 10_000)
							).catch((error) => ({ status: 0, body: String(error) }));
							if (result.status === 200) successes.set(id, successes.get(id) + 1);
							else failures.push({ node: node.hostname, id, ...result });
							await delay(20);
						}
					})()
				);
		await delay(2_000);
		await restartHome(restarting, nodes);
		await delay(5_000);
		stop = true;
		await Promise.all(workers);
		for (const id of keys) {
			assert.ok(successes.get(id) > 20, `${id}: ${successes.get(id)} increments`);
			await waitForCounter(nodes, id, successes.get(id));
			const final = await counter(home, id);
			// Every increment read the value its predecessor wrote: a lost update means two holders ran at once.
			assert.equal(final.n, successes.get(id), `${id}: ${JSON.stringify({ final, failures: failures.slice(0, 5) })}`);
		}
	});

	test('kill -9: the killed node’s keys, held and homed, grant again well inside the lease', async () => {
		const [killed, home, other] = nodes;
		const held = await keyHomedOn(nodes, home, killed, 'kill-held');
		const homed = await keyHomedOn(nodes, killed, other, 'kill-homed');
		const previous = await incarnationOf(killed);
		const pid = await readNodePid(killed);
		const killedAt = Date.now();
		process.kill(pid, 'SIGKILL');
		await waitForCondition(
			async () => {
				try {
					process.kill(pid, 0);
					return undefined;
				} catch {
					return true;
				}
			},
			{ timeoutMs: 30_000, description: 'the killed process to be gone' }
		);
		await restartStoppedNode(contexts[0], firstNodeEnv);
		nodes[0] = contexts[0].harper;
		const restarted = nodes[0];
		await waitForIncarnationAbove(restarted, previous, 'the killed node to come back');
		const heldAfter = await timeUntilGranted(other, held);
		const homedAfter = await timeUntilGranted(home, homed);
		console.log(
			`kill -9: held key granted after ${Date.now() - killedAt}ms (${heldAfter}ms of polling), homed key after ${homedAfter}ms more`
		);
		assert.ok(Date.now() - killedAt < AVAILABLE_BOUND_MS);
		await waitForMesh(nodes);
	});

	test('a delegation request delivered twice does not hold the key past the holder’s release (harper#2582)', async () => {
		const [duplicating, home, other] = nodes;
		const id = await keyHomedOn(nodes, home, duplicating, 'dup');
		const held = await call(duplicating, 'LockHold/', { id, lease: 5_000, timeout: 10_000 });
		assert.equal(held.status, 200, JSON.stringify(held.body));
		await call(duplicating, 'LockRelease/', { token: held.body.token });
		// The contender's recall drains the holder, whose release names the one token the home holds —
		// with a diverged token the key stayed held for the whole delegation lease.
		const startedAt = Date.now();
		const contended = await lockOnce(other, id, 20_000);
		assert.equal(contended.status, 200, JSON.stringify(contended.body));
		assert.ok(Date.now() - startedAt < 20_000);
	});
});

suite('record locks across a node restart: a member that is down (harper#3768)', { timeout: 900_000 }, (ctx) => {
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

	test('with a member down, the restarted node’s round cannot complete: its held keys stay held and its quarantine unprovable', async () => {
		const [restarting, home] = nodes;
		const held = await keyHomedOn(nodes, home, restarting, 'down-held');
		const grantedBefore = (await lockStats(home)).granted;
		await stopNode(contexts[2]);
		contexts.splice(2, 1);
		const previous = await incarnationOf(restarting);
		await restartNode(restarting);
		await waitForIncarnationAbove(restarting, previous, 'the restarted node to come back');
		await waitForPair(restarting, home);
		// The retire rides on the round's recall phase, which needs every member's probe answer; `down`
		// never answers, so nothing is retired: the dead epoch's grant stays on `home` and a contender is
		// refused inside its own timeout. Freeing it would only move the failure to the recovery barrier,
		// which asks every member — the bound that decides every member-down case (§4.5).
		await delay(5_000);
		const attempt = await lockOnce(home, held, 3_000);
		assert.notEqual(attempt.status, 200, `the held key was freed with a member down: ${JSON.stringify(attempt.body)}`);
		assert.equal((await lockStats(home)).granted, grantedBefore, 'the grant to the dead epoch is still there');
		const stats = await lockStats(restarting);
		assert.notEqual(stats.restartRecall?.state, 'attested', JSON.stringify(stats.restartRecall));
		assert.ok(stats.unprovenMs > 0, `the drain stays unprovable while a member is down: ${JSON.stringify(stats)}`);
		console.log(
			`member down: held key refused ${attempt.status}; restart round ${JSON.stringify(stats.restartRecall)}`
		);
	});
});

suite('record locks across a rolling worker restart (harper#3768)', { timeout: 900_000 }, (ctx) => {
	const contexts = [];
	let multi;
	let peer;
	let other;
	let nodes;
	let holdFile;

	before(async () => {
		holdFile = join(await mkdtemp(join(tmpdir(), 'record-lock-hold-')), 'hold');
		const started = await Promise.allSettled([
			startNode(ctx.name, { HARPER_TEST_RECORD_LOCK_HOLD_BARRIER_ANSWER: holdFile }, 3),
			startNode(ctx.name),
			startNode(ctx.name),
		]);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		[multi, peer, other] = contexts.map((c) => c.harper);
		nodes = [multi, peer, other];
		await connectMesh(nodes);
		await bootstrapHomeMap(nodes);
		await waitForRing(nodes, nodes.length);
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
	});

	test('replacing the coordinating worker frees the keys it held on peers and keeps its own keys available', async () => {
		const held = await keyHomedOn(nodes, peer, multi, 'worker-held');
		const heldLater = await keyHomedOn(nodes, peer, multi, 'worker-held-later');
		const homed = await keyHomedOn(nodes, multi, other, 'worker-homed');
		const before = await lockStats(multi);
		const restartedAt = Date.now();
		await sendOperation(multi, { operation: 'restart_service', service: 'http_workers' });
		const onHeld = lockOnce(other, held);
		const onHomed = lockOnce(peer, homed);
		const [heldResult, homedResult] = await Promise.all([onHeld, onHomed]);
		const elapsed = Date.now() - restartedAt;
		assert.equal(heldResult.status, 200, `the key the old worker held: ${JSON.stringify(heldResult.body)}`);
		assert.equal(homedResult.status, 200, `the key the node homes: ${JSON.stringify(homedResult.body)}`);
		assert.ok(elapsed < LOCK_TIMEOUT_MS, `both locks landed ${elapsed}ms after the worker restart`);
		// The rolling restart replaces every worker in turn; another database's handoff may bump the
		// node-wide incarnation first, which must not move this database's epoch (§4.5). Wait for THIS
		// database's owner to have been replaced.
		const after = await waitForCondition(
			async (signal) => {
				const stats = await lockStats(multi, signal);
				return stats?.ownerThreadId !== before.ownerThreadId &&
					stats?.restartRecall?.incarnation > before.restartRecall.incarnation
					? stats
					: undefined;
			},
			{ timeoutMs: 60_000, description: 'the new owner worker to coordinate under a new incarnation' }
		);
		assert.ok(
			after.delegateEpoch > before.delegateEpoch,
			`the epoch moved with the handoff: ${JSON.stringify({ before, after, status: (await clusterStatusOf(multi)).recordLocks })}`
		);
		// A key the departed worker held, asked for only now: the old grant is gone through the new
		// owner's epoch retire, not through a recall the old worker could still answer.
		const retired = await lockOnce(other, heldLater);
		assert.equal(retired.status, 200, `the departed worker's grant was not retired: ${JSON.stringify(retired.body)}`);
	});

	test('a barrier a replaced worker committed but never answered is asked again of its successor', async () => {
		const id = await keyHomedOn(nodes, peer, multi, 'worker-unanswered');
		const written = await call(multi, 'LockedIncrement/', { id, timeout: LOCK_TIMEOUT_MS, lease: LOCK_LEASE_MS });
		assert.equal(written.status, 200, JSON.stringify(written.body));
		const retriedBefore = (await lockStats(other)).freshness?.retried ?? 0;
		const result = await incrementAcrossHeldBarrier(other, id, holdFile, () =>
			sendOperation(multi, { operation: 'restart_service', service: 'http_workers' })
		);
		await waitForMesh(nodes);
		console.log(`held barrier, worker restart: the successor locked ${result.elapsedMs}ms after asking`);
		assert.equal(result.status, 200, `the successor across the worker restart: ${JSON.stringify(result.body)}`);
		assert.equal(result.body.n, written.body.n + 1, 'the successor read the write made under the old delegation');
		const freshness = (await lockStats(other)).freshness;
		assert.ok(freshness?.retried > retriedBefore, `the barrier was asked again: ${JSON.stringify(freshness)}`);
	});
});

suite('record locks across a node restart: a peer on the previous wire (harper#3768)', { timeout: 900_000 }, (ctx) => {
	const contexts = [];
	let nodes;

	before(async () => {
		const started = await Promise.allSettled([
			startNode(ctx.name),
			startNode(ctx.name, { HARPER_TEST_RECORD_LOCK_LEGACY_WIRE: '1' }),
			startNode(ctx.name),
		]);
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

	test('a current home retires the restarted node’s grants; a legacy home keeps them to the lease; everything else still locks', async () => {
		const [restarting, legacy, current] = nodes;
		const onCurrent = await keyHomedOn(nodes, current, restarting, 'mixed-current');
		const onLegacy = await keyHomedOn(nodes, legacy, restarting, 'mixed-legacy');
		const onLegacyDead = await keyHomedOn(nodes, legacy, restarting, 'mixed-legacy-dead');
		const restartingHomes = await keyHomedOn(nodes, restarting, legacy, 'mixed-homed');
		await restartHome(restarting, nodes);
		await waitForRing(nodes, nodes.length);
		// The legacy node answers the round without an epoch and the current one with its own, so the
		// round attests; by then the current home has heard the restarted node's epoch on the probe and
		// retired the dead grant.
		await waitForCondition(
			async (signal) => {
				const stats = await lockStats(restarting, signal);
				return stats?.restartRecall?.state === 'attested' ? stats : undefined;
			},
			{ timeoutMs: 90_000, pollMs: 500, description: 'the restarted node to attest its round' }
		);
		const freed = await lockOnce(current, onCurrent);
		assert.equal(
			freed.status,
			200,
			`${JSON.stringify(freed.body)}; current: ${JSON.stringify(await lockStats(current))}; restarted: ${JSON.stringify(await lockStats(restarting))}`
		);
		// The legacy home ignores the epoch: its grant to the dead incarnation stands, as before this change.
		// The restarted node itself renews it (same delegate) and locks at once, and once it has unlocked a
		// contender takes it over through the ordinary recall.
		const renewed = await lockOnce(restarting, onLegacy);
		assert.equal(renewed.status, 200, `renewal on the legacy home: ${JSON.stringify(renewed.body)}`);
		const takenOver = await lockOnce(current, onLegacy);
		assert.equal(takenOver.status, 200, `take-over on the legacy home: ${JSON.stringify(takenOver.body)}`);
		// A dead-epoch grant the restarted node never re-asked for is the legacy residue: the legacy home
		// recalls, the new incarnation has nothing to refuse without an epoch on the recall, and the home
		// waits for a release until the lease. A contender is refused inside its own timeout.
		const kept = await lockOnce(current, onLegacyDead, 3_000);
		assert.notEqual(
			kept.status,
			200,
			`a legacy home freed a grant it cannot know is dead: ${JSON.stringify(kept.body)}`
		);
		// And the legacy node, which answers the restart round without an epoch, locks on the restarted
		// node's keys once the round attests.
		const fromLegacy = await lockOnce(legacy, restartingHomes);
		assert.equal(fromLegacy.status, 200, JSON.stringify(fromLegacy.body));
	});
});
