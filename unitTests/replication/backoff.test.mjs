/**
 * Coverage for the shared replication backoff schedule (harper-pro#327). Every assertion that
 * involves jitter injects the RNG, so the bounds are exact rather than statistical.
 */

import { expect } from 'chai';
import { createBackoff } from '#src/replication/backoff';

describe('createBackoff', () => {
	it('doubles the ceiling per attempt and caps it', () => {
		const backoff = createBackoff({ initialMs: 500, maxMs: 4000, jitter: 'none' });
		expect([
			backoff.nextDelay(),
			backoff.nextDelay(),
			backoff.nextDelay(),
			backoff.nextDelay(),
			backoff.nextDelay(),
		]).to.deep.equal([500, 1000, 2000, 4000, 4000]);
	});

	it('honours a non-default factor', () => {
		const backoff = createBackoff({ initialMs: 100, maxMs: 10_000, factor: 3, jitter: 'none' });
		expect([backoff.nextDelay(), backoff.nextDelay(), backoff.nextDelay()]).to.deep.equal([100, 300, 900]);
	});

	it('draws full jitter across the whole window, never reaching the ceiling', () => {
		const draws = [0, 0.5, 0.999999];
		let i = 0;
		const backoff = createBackoff({ initialMs: 1000, maxMs: 1000, random: () => draws[i++] });
		expect([backoff.nextDelay(), backoff.nextDelay(), backoff.nextDelay()]).to.deep.equal([0, 500, 999]);
	});

	it('equal jitter draws only from the top half of the window, so the floor scales with the ceiling', () => {
		const low = createBackoff({ initialMs: 500, maxMs: 30_000, jitter: 'equal', random: () => 0 });
		expect([low.nextDelay(), low.nextDelay(), low.nextDelay()]).to.deep.equal([250, 500, 1000]);
		const high = createBackoff({ initialMs: 500, maxMs: 30_000, jitter: 'equal', random: () => 0.999999 });
		expect([high.nextDelay(), high.nextDelay(), high.nextDelay()]).to.deep.equal([499, 999, 1999]);
	});

	it('equal jitter still respects an explicit minMs floor above the half-ceiling', () => {
		const backoff = createBackoff({ initialMs: 400, maxMs: 400, minMs: 300, jitter: 'equal', random: () => 0 });
		expect(backoff.nextDelay()).to.equal(300);
	});

	it('floors the jitter window at minMs', () => {
		const backoff = createBackoff({ initialMs: 1000, maxMs: 1000, minMs: 400, random: () => 0 });
		expect(backoff.nextDelay(), 'a zero draw still waits the floor').to.equal(400);
		expect(createBackoff({ initialMs: 1000, maxMs: 1000, minMs: 400, random: () => 0.5 }).nextDelay()).to.equal(700);
	});

	it('keeps the ceiling above minMs even when maxMs is lower', () => {
		const backoff = createBackoff({ initialMs: 10, maxMs: 10, minMs: 250, random: () => 0.9 });
		expect(backoff.nextDelay()).to.equal(250);
	});

	it('decorrelates two schedules with identical failure timing', () => {
		const a = createBackoff({ initialMs: 500, maxMs: 30_000, random: () => 0.1 });
		const b = createBackoff({ initialMs: 500, maxMs: 30_000, random: () => 0.9 });
		const aDelays = [a.nextDelay(), a.nextDelay(), a.nextDelay()];
		const bDelays = [b.nextDelay(), b.nextDelay(), b.nextDelay()];
		expect(aDelays).to.not.deep.equal(bDelays);
		for (let i = 0; i < aDelays.length; i++) expect(aDelays[i]).to.be.below(bDelays[i]);
	});

	it('reset() returns to the first ceiling', () => {
		const backoff = createBackoff({ initialMs: 500, maxMs: 30_000, jitter: 'none' });
		backoff.nextDelay();
		backoff.nextDelay();
		expect(backoff.attempts).to.equal(2);
		expect(backoff.ceiling).to.equal(2000);
		backoff.reset();
		expect(backoff.attempts).to.equal(0);
		expect(backoff.nextDelay()).to.equal(500);
	});

	it('is never exhausted without a budget or attempt cap', () => {
		const backoff = createBackoff({ initialMs: 1, maxMs: 2 });
		for (let i = 0; i < 1000; i++) backoff.nextDelay();
		expect(backoff.exhausted).to.equal(false);
	});

	it('exhausts on the wall-clock deadline, not on the sum of requested sleeps', () => {
		// The delays are never actually awaited here: what exhausts the budget is the clock passing the
		// deadline. This is the send-auth reprobe's guarantee — an event-loop stall or a slow resolver
		// cannot extend the grace period past what it advertises.
		let clock = 0;
		const backoff = createBackoff({ initialMs: 500, maxMs: 5000, budgetMs: 30_000, now: () => clock });
		expect(backoff.exhausted).to.equal(false);
		backoff.nextDelay();
		clock = 29_999;
		expect(backoff.exhausted).to.equal(false);
		clock = 30_000;
		expect(backoff.exhausted).to.equal(true);
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
		expect(backoff.nextDelay()).to.equal(300);
	});

	it('restarts the budget clock on reset()', () => {
		let clock = 0;
		const backoff = createBackoff({ initialMs: 10, maxMs: 10, budgetMs: 100, now: () => clock });
		clock = 150;
		expect(backoff.exhausted).to.equal(true);
		backoff.reset();
		expect(backoff.exhausted).to.equal(false);
	});

	it('exhausts on maxAttempts even when the clock never advances', () => {
		const backoff = createBackoff({ initialMs: 10, maxMs: 10, budgetMs: 30_000, maxAttempts: 3, now: () => 0 });
		backoff.nextDelay();
		backoff.nextDelay();
		expect(backoff.exhausted).to.equal(false);
		backoff.nextDelay();
		expect(backoff.exhausted).to.equal(true);
	});
});
