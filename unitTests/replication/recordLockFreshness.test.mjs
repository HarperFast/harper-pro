/**
 * The freshness barrier's decisions without a cluster: which dependencies are refused outright,
 * that a wait settles only on the matching `(origin, position, nonce)` entry, how recovery probes
 * every member, and that every wait ends exactly once — on the entry, the deadline, the cap, or a
 * close.
 */
import assert from 'node:assert';
import {
	MAX_OUTSTANDING_BARRIERS,
	createFreshnessBarrier,
	isValidLogPosition,
} from '#src/replication/recordLockFreshness';
import { RECORD_LOCKS_CAPABILITY } from '#src/replication/protocolCapabilities';

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
		setTimer(callback, ms) {
			const handle = Symbol('timer');
			timers.set(handle, { callback, ms });
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
		advance(ms) {
			now += ms;
			const armed = Array.from(timers);
			for (const [handle, timer] of armed) {
				timers.delete(handle);
				timer.callback();
			}
		},
	};
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
	it('a failed or unusable reply fails the wait and frees the entry', async () => {
		const failed = harness();
		const wait = failed.barrier.establish('t', [['a', 5]], 1_000);
		failed.requests[0].reject(new Error('unreachable'));
		assert.match((await rejection(wait)).message, /could not obtain a record lock barrier from a/);
		assert.strictEqual(failed.barrier.stats().outstanding, 0);
		const unusable = harness();
		const wait2 = unusable.barrier.establish('t', [['a', 5]], 1_000);
		unusable.requests[0].resolve(NaN);
		assert.match((await rejection(wait2)).message, /without a usable position/);
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
	it('fails when any member cannot be drained', async () => {
		const { barrier, requests } = harness();
		const wait = barrier.establish('t', null, 1_000);
		requests[0].resolve(700);
		requests[1].reject(new Error('down'));
		assert.match((await rejection(wait)).message, /from b/);
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
		h.advance(60);
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
		h.advance(2);
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
	it('close settles everything and refuses new waits', async () => {
		const h = harness();
		const wait = h.barrier.establish('t', [['a', 5]], 1_000);
		h.barrier.close();
		assert.match((await rejection(wait)).message, /closed while waiting on a/);
		assert.strictEqual(h.timers.size, 0);
		assert.match((await rejection(h.barrier.establish('t', [['a', 5]], 1_000))).message, /is closed/);
	});
	it('the request itself is bounded by what is left of the lock deadline, never unbounded', async () => {
		// The sweep settles the WAIT; only this bound retires the response waiter and closes the
		// per-call fallback socket when a member accepts the connection and never answers.
		const h = harness();
		h.barrier.establish('t', [['a', 5]], 1_000).catch(() => {});
		assert.strictEqual(h.requests[0].timeoutMs, 1_000);
		// Clamped to the longest lease, and never zero — `sendOperation` reads 0 as "no bound".
		const capped = harness();
		capped.barrier.establish('t', [['a', 5]], Number.MAX_SAFE_INTEGER).catch(() => {});
		assert.strictEqual(capped.requests[0].timeoutMs, 300_000);
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
