/** Coverage for the shared replication backoff schedule (harper-pro#327). */

import assert from 'node:assert';
import { createBackoff } from '#src/replication/backoff';

describe('createBackoff', () => {
	it('doubles the ceiling per attempt and caps it', () => {
		const backoff = createBackoff({ initialMs: 500, maxMs: 4000, jitter: 'none' });
		assert.deepEqual(
			[backoff.nextDelay(), backoff.nextDelay(), backoff.nextDelay(), backoff.nextDelay(), backoff.nextDelay()],
			[500, 1000, 2000, 4000, 4000]
		);
	});

	it('honours a non-default factor', () => {
		const backoff = createBackoff({ initialMs: 100, maxMs: 10_000, factor: 3, jitter: 'none' });
		assert.deepEqual([backoff.nextDelay(), backoff.nextDelay(), backoff.nextDelay()], [100, 300, 900]);
	});

	it('draws full jitter across the whole window, never reaching the ceiling', () => {
		const draws = [0, 0.5, 0.999999];
		let i = 0;
		const backoff = createBackoff({ initialMs: 1000, maxMs: 1000, random: () => draws[i++] });
		assert.deepEqual([backoff.nextDelay(), backoff.nextDelay(), backoff.nextDelay()], [0, 500, 999]);
	});

	it('floors the jitter window at minMs', () => {
		const backoff = createBackoff({ initialMs: 1000, maxMs: 1000, minMs: 400, random: () => 0 });
		assert.equal(backoff.nextDelay(), 400, 'a zero draw still waits the floor');
		assert.equal(createBackoff({ initialMs: 1000, maxMs: 1000, minMs: 400, random: () => 0.5 }).nextDelay(), 700);
	});

	it('keeps the ceiling above minMs even when maxMs is lower', () => {
		const backoff = createBackoff({ initialMs: 10, maxMs: 10, minMs: 250, random: () => 0.9 });
		assert.equal(backoff.nextDelay(), 250);
	});

	it('decorrelates two schedules with identical failure timing', () => {
		const a = createBackoff({ initialMs: 500, maxMs: 30_000, random: () => 0.1 });
		const b = createBackoff({ initialMs: 500, maxMs: 30_000, random: () => 0.9 });
		const aDelays = [a.nextDelay(), a.nextDelay(), a.nextDelay()];
		const bDelays = [b.nextDelay(), b.nextDelay(), b.nextDelay()];
		assert.notDeepEqual(aDelays, bDelays);
		for (let i = 0; i < aDelays.length; i++) assert.ok(aDelays[i] < bDelays[i]);
	});

	it('reset() returns to the first ceiling', () => {
		const backoff = createBackoff({ initialMs: 500, maxMs: 30_000, jitter: 'none' });
		backoff.nextDelay();
		backoff.nextDelay();
		assert.equal(backoff.attempts, 2);
		assert.equal(backoff.ceiling, 2000);
		backoff.reset();
		assert.equal(backoff.attempts, 0);
		assert.equal(backoff.nextDelay(), 500);
	});

	it('is never exhausted without a budget or attempt cap', () => {
		const backoff = createBackoff({ initialMs: 1, maxMs: 2 });
		for (let i = 0; i < 1000; i++) backoff.nextDelay();
		assert.equal(backoff.exhausted, false);
	});

	it('exhausts on the wall-clock deadline, not on the sum of requested sleeps', () => {
		// The delays are never actually awaited here: what exhausts the budget is the clock passing the
		// deadline. This is the send-auth reprobe's guarantee — an event-loop stall or a slow resolver
		// cannot extend the grace period past what it advertises.
		let clock = 0;
		const backoff = createBackoff({ initialMs: 500, maxMs: 5000, budgetMs: 30_000, now: () => clock });
		assert.equal(backoff.exhausted, false);
		backoff.nextDelay();
		clock = 29_999;
		assert.equal(backoff.exhausted, false);
		clock = 30_000;
		assert.equal(backoff.exhausted, true);
		assert.equal(backoff.nextDelay(), undefined);
	});

	it('clamps the last delay so it cannot overshoot the deadline', () => {
		let clock = 0;
		const backoff = createBackoff({
			initialMs: 5000,
			maxMs: 5000,
			budgetMs: 1000,
			random: () => 0.999999,
			now: () => clock,
		});
		clock = 700;
		assert.equal(backoff.nextDelay(), 300);
	});

	it('restarts the budget clock on reset()', () => {
		let clock = 0;
		const backoff = createBackoff({ initialMs: 10, maxMs: 10, budgetMs: 100, now: () => clock });
		clock = 150;
		assert.equal(backoff.exhausted, true);
		backoff.reset();
		assert.equal(backoff.exhausted, false);
	});

	it('exhausts on maxAttempts even when the clock never advances', () => {
		const backoff = createBackoff({ initialMs: 10, maxMs: 10, budgetMs: 30_000, maxAttempts: 3, now: () => 0 });
		backoff.nextDelay();
		backoff.nextDelay();
		assert.equal(backoff.exhausted, false);
		backoff.nextDelay();
		assert.equal(backoff.exhausted, true);
		assert.equal(backoff.nextDelay(), undefined);
	});
});
