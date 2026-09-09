/**
 * Bounds on the two recovery closes in replicationConnection.ts (harper-pro#810).
 *
 * Both closes end the session that decided to make them, so neither bound can live on the session: a
 * session-scoped latch resets on the very reconnect it caused and bounds nothing. They live in a module
 * map keyed by (database, peer), and the predicates below are pure so the bounds can be pinned without a
 * live socket.
 */

import { expect } from 'chai';
import {
	recoveryCloseAllowed,
	recoveryCloseEpisodeCount,
	RECOVERY_CLOSE_EPISODE_MS,
	SEND_LOG_BREAK_BUDGET,
	DECODE_DROP_RESYNC_BUDGET,
} from '#src/replication/replicationConnection';

const NOW = 1_000_000_000;
const INTERVAL = 5 * 60_000;

describe('recoveryCloseAllowed', () => {
	it('allows the first close', () => {
		expect(recoveryCloseAllowed(0, 0, NOW, INTERVAL, SEND_LOG_BREAK_BUDGET)).to.equal(true);
	});

	it('suppresses a second close inside the interval', () => {
		// One reconnect per interval is a repair attempt; one per event is an outage.
		expect(recoveryCloseAllowed(NOW - INTERVAL + 1, 1, NOW, INTERVAL, SEND_LOG_BREAK_BUDGET)).to.equal(false);
	});

	it('allows another once the interval has elapsed', () => {
		expect(recoveryCloseAllowed(NOW - INTERVAL, 1, NOW, INTERVAL, SEND_LOG_BREAK_BUDGET)).to.equal(true);
	});

	it('stops entirely once the budget is spent, however long ago the last one was', () => {
		// A frequency bound alone leaves an unrepairable fault rebuilding the subscription forever. The
		// episode below is what keeps that from being permanent.
		expect(recoveryCloseAllowed(NOW - 10 * INTERVAL, 3, NOW, INTERVAL, 3)).to.equal(false);
	});
});

describe('recoveryCloseEpisodeCount', () => {
	it('carries the count forward inside one episode', () => {
		expect(recoveryCloseEpisodeCount(NOW - RECOVERY_CLOSE_EPISODE_MS + 1, 3, NOW)).to.equal(3);
	});

	it('starts a fresh episode once the gap exceeds the window, restoring the budget', () => {
		// A lifetime budget turns "this fault is unrepairable" into "this peer can never be recovered
		// again": three separate faults genuinely repaired over months would leave the fourth unhandled,
		// forever, until the process restarts.
		expect(recoveryCloseEpisodeCount(NOW - RECOVERY_CLOSE_EPISODE_MS, 3, NOW)).to.equal(0);
		expect(recoveryCloseAllowed(NOW - RECOVERY_CLOSE_EPISODE_MS, 0, NOW, INTERVAL, 3)).to.equal(true);
	});

	it('keeps a spent budget spent while the events keep coming, however long the fault runs', () => {
		// The episode measures EVENTS, not the closes they were allowed to cause. Keyed off the last close
		// instead, a fault no reconnect repairs would have its rejected events age the clock out and be
		// handed three more reconnects every hour, forever — the churn the budget exists to stop.
		expect(recoveryCloseEpisodeCount(NOW - 1_000, 3, NOW)).to.equal(3);
		expect(recoveryCloseAllowed(NOW - 10 * RECOVERY_CLOSE_EPISODE_MS, 3, NOW, INTERVAL, 3)).to.equal(false);
	});

	it('leaves a peer that has never had an event alone', () => {
		expect(recoveryCloseEpisodeCount(0, 0, NOW)).to.equal(0);
	});

	it('bounds both consumers, so neither can be left unbounded by a later edit', () => {
		expect(SEND_LOG_BREAK_BUDGET).to.be.greaterThan(0);
		expect(DECODE_DROP_RESYNC_BUDGET).to.be.greaterThan(0);
	});
});
