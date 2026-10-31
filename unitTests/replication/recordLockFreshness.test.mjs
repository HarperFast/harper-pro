/**
 * The freshness barrier's decisions without a cluster: which dependencies are refused outright,
 * that a wait settles only on the matching `(origin, position, nonce)` entry, how recovery probes
 * every member, and that every wait ends exactly once — on the entry, the deadline, the cap, or a
 * close.
 */
import assert from 'node:assert';
import {
	BARRIER_RETRY_MAX_MS,
	BARRIER_RETRY_MIN_MS,
	BARRIER_SWEEP_MS,
	MAX_OUTSTANDING_BARRIERS,
	createFreshnessBarrier,
	isValidLogPosition,
} from '#src/replication/recordLockFreshness';
import { RECORD_LOCKS_CAPABILITY } from '#src/replication/protocolCapabilities';
import { HOME_RESTART_RIDE_THROUGH_MS, RESTART_ATTEMPT_MS } from '#src/core/resources/recordLockCoordinator';

function harness(overrides = {}) {
	const requests = [];
	const timers = new Map();
	let now = 1_000;
	let nextNonce = 1;
	const deps = {
		thisNodeName: () => 'self',
		homeMap: () => ({ generation: 1, homes: ['self', 'a', 'b'], homeIncarnation: 1 }),
		peerLevel: () => RECORD_LOCKS_CAPABILITY,
		tableReplicates: () => true,
		isPoisoned: () => false,
		everRecloned: () => false,
		requestBarrier(origin, table, nonce, timeoutMs) {
			return new Promise((resolve, reject) => requests.push({ origin, table, nonce, timeoutMs, resolve, reject }));
		},
		monotonicNow: () => now,
		nonce: () => nextNonce++,
		// The top of each jittered step, so retry times are exact.
		random: () => 1,
		setTimer(callback, ms) {
			const handle = Symbol('timer');
			timers.set(handle, { callback, dueAt: now + ms });
			return handle;
		},
		clearTimer(handle) {
			timers.delete(handle);
		},
		...overrides,
	};
	const barrier = createFreshnessBarrier('data', deps);
	return {
		barrier,
		requests,
		timers,
		now: () => now,
		advance(ms) {
			now += ms;
			for (;;) {
				let next;
				for (const entry of timers)
					if (entry[1].dueAt <= now && (!next || entry[1].dueAt < next[1].dueAt)) next = entry;
				if (!next) return;
				timers.delete(next[0]);
				next[1].callback();
			}
		},
	};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Fail every request to `origin` the moment it is sent, as a closed socket does, stepping the clock
 * until `settled()`; returns the clock reading at each send.
 */
async function failUntilSettled(h, origin, settled) {
	const sentAt = [];
	// Steps past the longest lock lease, so any deadline ends the loop by settling.
	for (let i = 0; i < 13_000 && !settled(); i++) {
		const sent = h.requests.filter((request) => request.origin === origin);
		for (const request of sent.slice(sentAt.length)) {
			sentAt.push(h.now());
			request.reject(new Error('Connection closed  1006'));
		}
		await flush();
		if (settled()) break;
		h.advance(25);
		await flush();
	}
	return sentAt;
}

async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail('expected a rejection');
}

describe('createFreshnessBarrier: refusals before any request', () => {
	it('refuses a dependency on a node outside the home map', async () => {
		const { barrier, requests } = harness();
		const error = await rejection(barrier.establish('t', [['z', 5]], 1_000));
		assert.strictEqual(error.statusCode, 503);
		assert.match(error.message, /not a member/);
		assert.strictEqual(requests.length, 0);
		assert.strictEqual(barrier.stats().rejected['not-member'], 1);
	});
	it('refuses a peer at another capability level, a poisoned pair, an unreplicated table, an invalid position', async () => {
		const level = harness({ peerLevel: () => RECORD_LOCKS_CAPABILITY - 1 });
		assert.match((await rejection(level.barrier.establish('t', [['a', 5]], 1_000))).message, /capability level/);
		const poisoned = harness({ isPoisoned: (origin, table) => origin === 'a' && table === 't' });
		assert.match((await rejection(poisoned.barrier.establish('t', [['a', 5]], 1_000))).message, /replication hole/);
		const unreplicated = harness({ tableReplicates: () => false });
		assert.match(
			(await rejection(unreplicated.barrier.establish('t', [['a', 5]], 1_000))).message,
			/does not replicate/
		);
		const invalid = harness();
		assert.match((await rejection(invalid.barrier.establish('t', [['a', -1]], 1_000))).message, /invalid log position/);
		for (const h of [level, poisoned, unreplicated, invalid]) assert.strictEqual(h.requests.length, 0);
	});
	it('refuses every dependency before it starts any wait, so a later refusal leaves nothing asking', async () => {
		const poisoned = harness({ isPoisoned: (origin) => origin === 'b' });
		const error = await rejection(
			poisoned.barrier.establish(
				't',
				[
					['a', 5],
					['b', 6],
				],
				1_000
			)
		);
		assert.match(error.message, /replication hole/);
		assert.strictEqual(poisoned.requests.length, 0);
		assert.strictEqual(poisoned.barrier.stats().outstanding, 0);
		const invalid = harness();
		const error2 = await rejection(
			invalid.barrier.establish(
				't',
				[
					['a', 5],
					['b', -1],
				],
				1_000
			)
		);
		assert.match(error2.message, /invalid log position/);
		assert.strictEqual(invalid.requests.length, 0);
	});
	it('refuses everything while the home map is withheld', async () => {
		const { barrier } = harness({ homeMap: () => undefined });
		assert.match(
			(await rejection(barrier.establish('t', [['a', 5]], 1_000))).message,
			/no agreed record lock home map/
		);
	});
	it('treats own history as proven unless the database was recloned', async () => {
		const intact = harness();
		await intact.barrier.establish('t', [['self', 5]], 1_000);
		assert.strictEqual(intact.requests.length, 0);
		const recloned = harness({ everRecloned: () => true });
		assert.match((await rejection(recloned.barrier.establish('t', [['self', 5]], 1_000))).message, /recloned/);
	});
	it('an empty dependency set resolves without a request', async () => {
		const { barrier, requests } = harness();
		await barrier.establish('t', [], 1_000);
		assert.strictEqual(requests.length, 0);
	});
});

describe('createFreshnessBarrier: a clean handoff waits on the exact entry', () => {
	it('registers the nonce before the request leaves and settles on the matching entry', async () => {
		const { barrier, requests } = harness();
		const wait = barrier.establish('t', [['a', 5]], 1_000);
		assert.strictEqual(requests.length, 1);
		assert.deepStrictEqual([requests[0].origin, requests[0].table, requests[0].nonce], ['a', 't', 1]);
		assert.strictEqual(barrier.stats().outstanding, 1);
		requests[0].resolve(700);
		await Promise.resolve();
		let settled = false;
		wait.then(() => (settled = true));
		await Promise.resolve();
		assert.strictEqual(settled, false, 'the reply alone does not prove the entry applied');
		assert.strictEqual(barrier.noteBarrierApplied('a', 700, 1), true);
		await wait;
		assert.strictEqual(barrier.stats().applied, 1);
		assert.strictEqual(barrier.stats().outstanding, 0);
	});
	it('the entry can apply before the reply arrives', async () => {
		const { barrier, requests } = harness();
		const wait = barrier.establish('t', [['a', 5]], 1_000);
		assert.strictEqual(barrier.noteBarrierApplied('a', 700, 1), true);
		requests[0].resolve(700);
		await wait;
		assert.strictEqual(barrier.stats().applied, 1);
	});
	it('a wrong nonce, a wrong origin, or a wrong position settles nothing or fails the wait', async () => {
		const { barrier, requests } = harness();
		const wait = barrier.establish('t', [['a', 5]], 1_000);
		requests[0].resolve(700);
		await Promise.resolve();
		assert.strictEqual(barrier.noteBarrierApplied('a', 700, 99), false);
		assert.strictEqual(barrier.noteBarrierApplied('b', 700, 1), false);
		assert.strictEqual(barrier.stats().outstanding, 1);
		assert.strictEqual(barrier.noteBarrierApplied('a', 701, 1), true);
		assert.match((await rejection(wait)).message, /different position/);
	});
	it('one request per dependency; all must apply', async () => {
		const { barrier, requests } = harness();
		const wait = barrier.establish(
			't',
			[
				['a', 5],
				['b', 9],
			],
			1_000
		);
		assert.strictEqual(requests.length, 2);
		requests[0].resolve(700);
		requests[1].resolve(800);
		await Promise.resolve();
		barrier.noteBarrierApplied('a', 700, 1);
		let settled = false;
		wait.then(() => (settled = true));
		await Promise.resolve();
		assert.strictEqual(settled, false);
		barrier.noteBarrierApplied('b', 800, 2);
		await wait;
	});
	it('an unusable reply fails the wait at once and frees the entry', async () => {
		const unusable = harness();
		const wait = unusable.barrier.establish('t', [['a', 5]], 30_000);
		unusable.requests[0].resolve(NaN);
		assert.match((await rejection(wait)).message, /without a usable position/);
		assert.strictEqual(unusable.barrier.stats().outstanding, 0);
		assert.strictEqual(unusable.requests.length, 1);
	});
});

describe('createFreshnessBarrier: recovery probes every other member', () => {
	it('returns the established positions in member order', async () => {
		const { barrier, requests } = harness();
		const wait = barrier.establish('t', null, 1_000);
		assert.deepStrictEqual(
			requests.map((request) => request.origin),
			['a', 'b']
		);
		requests[0].resolve(700);
		requests[1].resolve(800);
		await Promise.resolve();
		barrier.noteBarrierApplied('b', 800, 2);
		barrier.noteBarrierApplied('a', 700, 1);
		assert.deepStrictEqual(await wait, [
			['a', 700],
			['b', 800],
		]);
	});
	it('fails when any member cannot be drained within the lock deadline', async () => {
		const h = harness();
		const startedAt = h.now();
		const wait = h.barrier.establish('t', null, 30_000);
		let settled;
		wait.then(
			() => (settled = 'resolved'),
			(error) => (settled = error)
		);
		h.requests[0].resolve(700);
		h.barrier.noteBarrierApplied('a', 700, 1);
		await failUntilSettled(h, 'b', () => settled);
		assert.match(settled.message, /from b/);
		assert.ok(h.now() - startedAt <= 30_000, `settled after ${h.now() - startedAt}ms`);
	});
	it('refuses recovery outright when a member is poisoned or at another level', async () => {
		const { barrier, requests } = harness({ isPoisoned: (origin) => origin === 'b' });
		assert.match((await rejection(barrier.establish('t', null, 1_000))).message, /replication hole/);
		assert.strictEqual(requests.length, 0);
	});
});

describe('createFreshnessBarrier: every wait ends exactly once', () => {
	it('the deadline sweep times out a wait and frees its entry', async () => {
		const h = harness();
		const wait = h.barrier.establish('t', [['a', 5]], 100);
		assert.strictEqual(h.timers.size, 1);
		h.advance(50);
		assert.strictEqual(h.barrier.stats().outstanding, 1);
		h.advance(BARRIER_SWEEP_MS);
		const error = await rejection(wait);
		assert.match(error.message, /elapsed before a confirmed/);
		assert.strictEqual(h.barrier.stats().timeouts, 1);
		assert.strictEqual(h.barrier.stats().outstanding, 0);
		assert.strictEqual(h.timers.size, 0, 'nothing outstanding, nothing armed');
		h.requests[0].resolve(700);
		await Promise.resolve();
		assert.strictEqual(h.barrier.noteBarrierApplied('a', 700, 1), false, 'a late entry finds nothing waiting');
	});
	it('a thousand short waits vanish at their deadline', async () => {
		const h = harness();
		const waits = Array.from({ length: 1_000 }, () => h.barrier.establish('t', [['a', 5]], 1));
		assert.strictEqual(h.barrier.stats().outstanding, 1_000);
		h.advance(BARRIER_SWEEP_MS);
		for (const wait of waits) assert.strictEqual((await rejection(wait)).statusCode, 503);
		assert.strictEqual(h.barrier.stats().outstanding, 0);
		assert.strictEqual(h.barrier.stats().timeouts, 1_000);
	});
	it('the cap rejects rather than queues', async () => {
		const h = harness();
		for (let i = 0; i < MAX_OUTSTANDING_BARRIERS; i++) h.barrier.establish('t', [['a', 5]], 1_000).catch(() => {});
		assert.match((await rejection(h.barrier.establish('t', [['a', 5]], 1_000))).message, /too many/);
		assert.strictEqual(h.barrier.stats().rejected.capacity, 1);
		h.barrier.close();
	});
	it('the cap counts every wait a call would start, and starts none past it', async () => {
		const h = harness();
		for (let i = 0; i < MAX_OUTSTANDING_BARRIERS - 1; i++) h.barrier.establish('t', [['a', 5]], 1_000).catch(() => {});
		const sent = h.requests.length;
		const error = await rejection(
			h.barrier.establish(
				't',
				[
					['a', 5],
					['b', 6],
				],
				1_000
			)
		);
		assert.match(error.message, /too many/);
		assert.strictEqual(h.requests.length, sent);
		assert.strictEqual(h.barrier.stats().outstanding, MAX_OUTSTANDING_BARRIERS - 1);
		h.barrier.close();
	});
	it('close settles everything and refuses new waits', async () => {
		const h = harness();
		const wait = h.barrier.establish('t', [['a', 5]], 1_000);
		h.barrier.close();
		assert.match((await rejection(wait)).message, /closed while waiting on a/);
		assert.strictEqual(h.timers.size, 0);
		assert.match((await rejection(h.barrier.establish('t', [['a', 5]], 1_000))).message, /is closed/);
	});
	it('the request itself is bounded by one attempt or what is left of the lock deadline, never unbounded', async () => {
		// The sweep settles the WAIT; only this bound retires the response waiter and closes the
		// per-call fallback socket when a member accepts the connection and never answers.
		const h = harness();
		h.barrier.establish('t', [['a', 5]], 1_000).catch(() => {});
		assert.strictEqual(h.requests[0].timeoutMs, 1_000);
		// One attempt's bound under a longer deadline, and never zero — `sendOperation` reads 0 as "no bound".
		const capped = harness();
		capped.barrier.establish('t', [['a', 5]], Number.MAX_SAFE_INTEGER).catch(() => {});
		assert.strictEqual(capped.requests[0].timeoutMs, RESTART_ATTEMPT_MS);
		const elapsed = harness();
		elapsed.barrier.establish('t', [['a', 5]], 0).catch(() => {});
		assert.strictEqual(elapsed.requests[0].timeoutMs, 1);
	});
	it('the wait bound never exceeds the longest lock lease', () => {
		const h = harness();
		h.barrier.establish('t', [['a', 5]], Number.MAX_SAFE_INTEGER).catch(() => {});
		h.advance(300_001);
		assert.strictEqual(h.barrier.stats().outstanding, 0);
	});
});

describe('createFreshnessBarrier: a failed request rides through its origin restarting (record-locks.md §4.5)', () => {
	const closedSocket = () => new Error('Connection closed  1006');

	it('asks again with a fresh nonce, past a closed socket and a booting origin’s refusal, and settles on the retry’s own entry', async () => {
		const h = harness();
		const wait = h.barrier.establish('t', [['a', 5]], 30_000);
		let settled = false;
		wait.then(
			() => (settled = true),
			() => (settled = true)
		);
		h.requests[0].reject(closedSocket());
		await flush();
		h.advance(BARRIER_RETRY_MIN_MS - 1);
		await flush();
		assert.strictEqual(settled, false, 'one closed socket does not fail the wait');
		assert.strictEqual(h.requests.length, 1, 'not before its backoff');
		h.advance(1);
		await flush();
		assert.deepStrictEqual([h.requests[1].origin, h.requests[1].table, h.requests[1].nonce], ['a', 't', 2]);
		// The restarted origin answers before its own home map is agreed.
		h.requests[1].reject(new Error('self is not a member of the record lock home map for data'));
		await flush();
		h.advance(BARRIER_RETRY_MIN_MS * 2);
		await flush();
		assert.strictEqual(h.requests[2].nonce, 3);
		// The first attempt committed after all, at the position the retry is about to answer with.
		assert.strictEqual(h.barrier.noteBarrierApplied('a', 800, 1), false);
		h.requests[2].resolve(800);
		await flush();
		assert.strictEqual(settled, false, 'an earlier attempt’s entry proves nothing for this one');
		assert.strictEqual(h.barrier.noteBarrierApplied('a', 800, 3), true);
		await wait;
		assert.strictEqual(h.barrier.stats().retried, 2);
		assert.strictEqual(h.barrier.stats().outstanding, 0);
	});
	it('stops sending at the lock deadline and ends with the last failure', async () => {
		const h = harness();
		const startedAt = h.now();
		const wait = h.barrier.establish('t', [['a', 5]], 60_000);
		let settled;
		wait.then(
			() => (settled = 'resolved'),
			(error) => (settled = error)
		);
		const sentAt = await failUntilSettled(h, 'a', () => settled);
		assert.match(settled.message, /could not obtain a record lock barrier from a for data\.t: Connection closed/);
		assert.strictEqual(settled.statusCode, 503);
		assert.ok(h.now() - startedAt <= 60_000, `settled after ${h.now() - startedAt}ms`);
		assert.ok(sentAt.at(-1) - startedAt > HOME_RESTART_RIDE_THROUGH_MS, 'asks past core’s home ride-through');
		for (const at of sentAt) assert.ok(at - startedAt < 60_000, `${at - startedAt}ms`);
		const gaps = sentAt.slice(1).map((at, index) => at - sentAt[index]);
		for (const [index, gap] of gaps.entries()) {
			const step = Math.min(BARRIER_RETRY_MAX_MS, BARRIER_RETRY_MIN_MS * 2 ** index);
			assert.ok(gap >= step && gap < step + 25, `gap ${index}: ${gap}ms for a ${step}ms step`);
		}
		assert.strictEqual(h.barrier.stats().outstanding, 0);
	});
	it('sends at most 33 requests in a 30 s wait, even when every jittered delay is the shortest', async () => {
		const h = harness({ random: () => 0 });
		const wait = h.barrier.establish('t', [['a', 5]], 30_000);
		let settled;
		wait.catch((error) => (settled = error));
		const sentAt = await failUntilSettled(h, 'a', () => settled);
		assert.ok(settled);
		assert.ok(sentAt.length <= 33, `${sentAt.length} requests`);
	});
	it('an origin unreachable for 20 s inside a 30 s deadline is asked again until it answers', async () => {
		const h = harness();
		const wait = h.barrier.establish('t', [['a', 5]], 30_000);
		let settled = false;
		wait.then(
			() => (settled = true),
			() => (settled = true)
		);
		const startedAt = h.now();
		await failUntilSettled(h, 'a', () => settled || h.now() - startedAt >= 20_000);
		assert.strictEqual(settled, false, 'still asking after 20 s of refused connections');
		h.advance(BARRIER_RETRY_MAX_MS);
		await flush();
		const retry = h.requests.at(-1);
		retry.resolve(900);
		await flush();
		assert.strictEqual(h.barrier.noteBarrierApplied('a', 900, retry.nonce), true);
		await wait;
		assert.ok(h.now() - startedAt > 20_000);
	});
	it('asks again on a fresh nonce when an attempt goes unanswered, doubling the next attempt’s bound', async () => {
		const h = harness();
		const wait = h.barrier.establish('t', [['a', 5]], 60_000);
		assert.strictEqual(h.requests[0].timeoutMs, RESTART_ATTEMPT_MS);
		// The origin accepts the request and never answers; the transport gives up at that bound.
		h.advance(RESTART_ATTEMPT_MS);
		h.requests[0].reject(new Error(`record_lock_barrier to a did not answer within ${RESTART_ATTEMPT_MS}ms`));
		await flush();
		h.advance(BARRIER_RETRY_MIN_MS);
		await flush();
		assert.deepStrictEqual([h.requests[1].nonce, h.requests[1].timeoutMs], [2, RESTART_ATTEMPT_MS * 2]);
		// Slow rather than gone: the doubled bound leaves it time to answer.
		h.advance(RESTART_ATTEMPT_MS + 1_000);
		h.requests[1].resolve(800);
		await flush();
		assert.strictEqual(h.barrier.noteBarrierApplied('a', 800, 2), true);
		await wait;
		assert.strictEqual(h.barrier.stats().outstanding, 0);
	});
	it('keeps one attempt’s bound after a refused connection', async () => {
		const h = harness();
		h.barrier.establish('t', [['a', 5]], 60_000).catch(() => {});
		h.requests[0].reject(closedSocket());
		await flush();
		h.advance(BARRIER_RETRY_MIN_MS);
		await flush();
		assert.strictEqual(h.requests[1].timeoutMs, RESTART_ATTEMPT_MS);
		h.barrier.close();
	});
	it('takes a retry’s reply that arrives at the end of its attempt', async () => {
		const h = harness();
		const wait = h.barrier.establish('t', [['a', 5]], 60_000);
		h.requests[0].reject(closedSocket());
		await flush();
		h.advance(BARRIER_RETRY_MIN_MS);
		await flush();
		// Forwarded through a sibling worker, the reply crosses one more hop after the bound.
		h.advance(RESTART_ATTEMPT_MS);
		h.requests[1].resolve(800);
		await flush();
		assert.strictEqual(h.barrier.noteBarrierApplied('a', 800, 2), true);
		await wait;
	});
	it('fits the last attempt into what is left of the lock deadline, and waits no further', async () => {
		const h = harness();
		const wait = h.barrier.establish('t', [['a', 5]], 400);
		h.requests[0].reject(closedSocket());
		await flush();
		h.advance(400 - BARRIER_RETRY_MIN_MS - 1);
		await flush();
		assert.strictEqual(h.requests.length, 1);
		h.advance(1);
		await flush();
		assert.strictEqual(h.requests.length, 2, 'the backoff is shortened to leave the attempt a step');
		assert.strictEqual(h.requests[1].timeoutMs, BARRIER_RETRY_MIN_MS);
		h.requests[1].reject(closedSocket());
		assert.match((await rejection(wait)).message, /Connection closed/);
		assert.strictEqual(h.requests.length, 2);
		const short = harness();
		const wait2 = short.barrier.establish('t', [['a', 5]], BARRIER_RETRY_MIN_MS - 1);
		short.requests[0].reject(closedSocket());
		assert.match((await rejection(wait2)).message, /Connection closed/, 'no room left for an attempt');
		assert.strictEqual(short.requests.length, 1);
	});
	it('keeps asking until the deadline, however the last backoff is drawn', async () => {
		// A draw whose last full step would overshoot the deadline.
		const h = harness({ random: () => 0.75 });
		const startedAt = h.now();
		const wait = h.barrier.establish('t', [['a', 5]], 20_000);
		let settled;
		wait.catch((error) => (settled = error));
		const sentAt = await failUntilSettled(h, 'a', () => settled);
		assert.strictEqual(sentAt.at(-1) - startedAt, 20_000 - BARRIER_RETRY_MIN_MS);
	});
	it('a retry still answered keeps waiting for its entry until the lock deadline', async () => {
		const h = harness();
		const wait = h.barrier.establish('t', [['a', 5]], 60_000);
		h.requests[0].reject(closedSocket());
		await flush();
		h.advance(BARRIER_RETRY_MIN_MS);
		await flush();
		h.requests[1].resolve(800);
		await flush();
		// The entry is behind the origin's replication backlog: the attempt bound limits asking, not applying.
		h.advance(RESTART_ATTEMPT_MS + BARRIER_SWEEP_MS);
		assert.strictEqual(h.barrier.stats().outstanding, 1);
		assert.strictEqual(h.barrier.noteBarrierApplied('a', 800, 2), true);
		await wait;
	});
	it('each retry passes the refusals a first request does, and a reader that throws ends the wait with 503', async () => {
		let poisoned = false;
		const h = harness({ isPoisoned: () => poisoned });
		const wait = h.barrier.establish('t', [['a', 5]], 30_000);
		h.requests[0].reject(closedSocket());
		await flush();
		poisoned = true;
		h.advance(BARRIER_RETRY_MIN_MS);
		assert.match((await rejection(wait)).message, /replication hole/);
		assert.strictEqual(h.requests.length, 1);

		let homes = ['self', 'a', 'b'];
		const left = harness({ homeMap: () => ({ generation: 2, homes, homeIncarnation: 1 }) });
		const wait2 = left.barrier.establish('t', [['a', 5]], 30_000);
		left.requests[0].reject(closedSocket());
		await flush();
		homes = ['self', 'b'];
		left.advance(BARRIER_RETRY_MIN_MS);
		assert.match((await rejection(wait2)).message, /not a member/);
		assert.strictEqual(left.requests.length, 1);

		let throwing = false;
		const broken = harness({
			peerLevel() {
				if (throwing) throw new Error('status buffer unavailable');
				return RECORD_LOCKS_CAPABILITY;
			},
		});
		const wait3 = broken.barrier.establish('t', [['a', 5]], 30_000);
		broken.requests[0].reject(closedSocket());
		await flush();
		throwing = true;
		broken.advance(BARRIER_RETRY_MIN_MS);
		const error = await rejection(wait3);
		assert.strictEqual(error.statusCode, 503);
		assert.match(error.message, /status buffer unavailable/);
		broken.advance(BARRIER_RETRY_MAX_MS * 4);
		await flush();
		assert.strictEqual(broken.requests.length, 1, 'nothing left armed to send again');
	});
	it('close() settles a wait that is between attempts', async () => {
		const h = harness();
		const wait = h.barrier.establish('t', [['a', 5]], 30_000);
		h.requests[0].reject(closedSocket());
		await flush();
		h.barrier.close();
		assert.match((await rejection(wait)).message, /closed while waiting on a/);
		assert.strictEqual(h.timers.size, 0);
		assert.strictEqual(h.requests.length, 1);
	});
	it('a wait between attempts counts against the cap', async () => {
		const h = harness();
		for (let i = 0; i < MAX_OUTSTANDING_BARRIERS; i++) h.barrier.establish('t', [['a', 5]], 30_000).catch(() => {});
		for (const request of h.requests) request.reject(closedSocket());
		await flush();
		assert.strictEqual(h.barrier.stats().outstanding, MAX_OUTSTANDING_BARRIERS);
		assert.match((await rejection(h.barrier.establish('t', [['a', 5]], 1_000))).message, /too many/);
		h.barrier.close();
	});
	it('a recovery barrier asks again only the member whose request failed', async () => {
		const h = harness();
		const wait = h.barrier.establish('t', null, 30_000);
		h.requests[0].resolve(700);
		h.requests[1].reject(closedSocket());
		await flush();
		h.barrier.noteBarrierApplied('a', 700, 1);
		h.advance(BARRIER_RETRY_MIN_MS);
		await flush();
		assert.deepStrictEqual(
			h.requests.map((request) => request.origin),
			['a', 'b', 'b']
		);
		// The entry can apply before the retry's reply arrives.
		assert.strictEqual(h.barrier.noteBarrierApplied('b', 800, 3), true);
		h.requests[2].resolve(800);
		assert.deepStrictEqual(await wait, [
			['a', 700],
			['b', 800],
		]);
	});
});

describe('isValidLogPosition', () => {
	it('accepts the replication clock domain only', () => {
		for (const bad of [0, -1, NaN, Infinity, 8.64e15 + 1, '5', null])
			assert.strictEqual(isValidLogPosition(bad), false, String(bad));
		assert.strictEqual(isValidLogPosition(1789480100774.2732), true);
	});
});

describe('createFreshnessBarrier: a hole recorded while the barrier is in flight', () => {
	it('fails the wait at settle time even though the entry matched, in either arrival order', async () => {
		let poisoned = false;
		const first = harness({ isPoisoned: () => poisoned });
		const wait = first.barrier.establish('t', [['a', 5]], 1_000);
		first.requests[0].resolve(700);
		await Promise.resolve();
		poisoned = true;
		assert.strictEqual(first.barrier.noteBarrierApplied('a', 700, 1), true);
		assert.match((await rejection(wait)).message, /replication hole while its barrier was in flight/);
		assert.strictEqual(first.barrier.stats().rejected.poisoned, 1);
		assert.strictEqual(first.barrier.stats().applied, 0);

		poisoned = false;
		const second = harness({ isPoisoned: () => poisoned });
		const wait2 = second.barrier.establish('t', [['a', 5]], 1_000);
		second.barrier.noteBarrierApplied('a', 700, 1);
		poisoned = true;
		second.requests[0].resolve(700);
		assert.match((await rejection(wait2)).message, /replication hole while its barrier was in flight/);
	});
});

describe('createFreshnessBarrier: a poison check that throws', () => {
	it('is answered as poisoned — refused up front, and settled with 503 rather than escaping', async () => {
		const upFront = harness({
			isPoisoned() {
				throw new Error('store unavailable');
			},
		});
		assert.match((await rejection(upFront.barrier.establish('t', [['a', 5]], 1_000))).message, /replication hole/);
		let throwing = false;
		const atSettle = harness({
			isPoisoned() {
				if (throwing) throw new Error('store unavailable');
				return false;
			},
		});
		const wait = atSettle.barrier.establish('t', [['a', 5]], 1_000);
		atSettle.requests[0].resolve(700);
		await Promise.resolve();
		throwing = true;
		assert.strictEqual(atSettle.barrier.noteBarrierApplied('a', 700, 1), true);
		const error = await rejection(wait);
		assert.strictEqual(error.statusCode, 503);
	});
});
