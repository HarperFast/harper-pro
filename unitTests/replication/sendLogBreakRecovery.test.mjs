/**
 * The bound on the decode-drop structure resync (harper-pro#810).
 *
 * That close ENDS the session that decided to make it, so its bound cannot live on the session: a
 * session-scoped latch resets on the very reconnect it caused and bounds nothing. It lives in the shared
 * (database, peer) status buffer, and the predicates below are pure so they can be pinned without a live
 * socket.
 *
 * The send-log-break repair needs none of this: it replaces a cached local rather than closing anything,
 * so session-local interval floors are the whole bound — `mayRebuildSendRange` below.
 */

import { expect } from 'chai';
import {
	claimRecoveryCloseInSharedStatus,
	DECODE_DROP_CLOSE_COUNT_POSITION,
	DECODE_DROP_LAST_CLOSE_POSITION,
	DECODE_DROP_LAST_EVENT_POSITION,
	mayRebuildSendRange,
	rebuildRetryDelayMs,
	SEND_LOG_REPAIR_INTERVAL_MS,
	SEND_LOG_QUARANTINE_RECHECK_MS,
	recoveryCloseAllowed,
	recoveryCloseEpisodeCount,
	RECOVERY_CLOSE_EPISODE_MS,
	DECODE_DROP_RESYNC_BUDGET,
} from '#src/replication/replicationConnection';
import { REPLICATION_SHARED_STATUS_SLOTS } from '#src/replication/knownNodes';

const NOW = 1_000_000_000;
const INTERVAL = 5 * 60_000;

describe('recoveryCloseAllowed', () => {
	it('allows the first close', () => {
		expect(recoveryCloseAllowed(0, 0, NOW, INTERVAL, DECODE_DROP_RESYNC_BUDGET)).to.equal(true);
	});

	it('suppresses a second close inside the interval', () => {
		// One reconnect per interval is a repair attempt; one per event is an outage.
		expect(recoveryCloseAllowed(NOW - INTERVAL + 1, 1, NOW, INTERVAL, DECODE_DROP_RESYNC_BUDGET)).to.equal(false);
	});

	it('allows another once the interval has elapsed', () => {
		expect(recoveryCloseAllowed(NOW - INTERVAL, 1, NOW, INTERVAL, DECODE_DROP_RESYNC_BUDGET)).to.equal(true);
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

	it('lets a spent budget lapse after an idle episode', () => {
		expect(recoveryCloseEpisodeCount(NOW - RECOVERY_CLOSE_EPISODE_MS, DECODE_DROP_RESYNC_BUDGET, NOW)).to.equal(0);
		expect(recoveryCloseAllowed(NOW - RECOVERY_CLOSE_EPISODE_MS, 0, NOW, INTERVAL, DECODE_DROP_RESYNC_BUDGET)).to.equal(
			true
		);
	});

	it('leaves a peer that has never had an event alone', () => {
		expect(recoveryCloseEpisodeCount(0, 0, NOW)).to.equal(0);
	});

	it('is bounded, so it cannot be left unbounded by a later edit', () => {
		expect(DECODE_DROP_RESYNC_BUDGET).to.be.greaterThan(0);
	});
});

describe('mayRebuildSendRange — when the stopped send range may be rebuilt', () => {
	it('rebuilds a torn tail on first sight: recovering it is the point', () => {
		expect(mayRebuildSendRange(false, NOW, 0, NOW)).to.equal(true);
	});

	it('floors repeated rebuilds of a torn tail, which is not always walkable yet', () => {
		// Until something is written past the tear the fresh iterator stops at the same frame, so without
		// the floor this would be a `getRange` per commit.
		expect(mayRebuildSendRange(false, NOW, NOW, NOW + SEND_LOG_REPAIR_INTERVAL_MS - 1)).to.equal(false);
		expect(mayRebuildSendRange(false, NOW, NOW, NOW + SEND_LOG_REPAIR_INTERVAL_MS)).to.equal(true);
	});

	it('never rebuilds a quarantined break on first sight', () => {
		// A fresh iterator stops at the same frame, so rebuilding immediately would spin — which is the
		// behaviour harper#2087's fail-stop policy exists to avoid.
		expect(mayRebuildSendRange(true, NOW, 0, NOW)).to.equal(false);
		expect(mayRebuildSendRange(true, NOW, 0, NOW + SEND_LOG_REPAIR_INTERVAL_MS)).to.equal(false);
	});

	it('re-checks a quarantined break once, long after it appeared', () => {
		// But it must look again: never rebuilding leaves the cache latched for the life of the session even
		// after an operator repairs the log — and on a merged multi-log range one origin's break would go on
		// silencing every healthy origin on that subscription.
		expect(mayRebuildSendRange(true, NOW, 0, NOW + SEND_LOG_QUARANTINE_RECHECK_MS)).to.equal(true);
		// And the window then runs from the rebuild, not from the original sighting.
		expect(
			mayRebuildSendRange(true, NOW, NOW + SEND_LOG_QUARANTINE_RECHECK_MS, NOW + SEND_LOG_QUARANTINE_RECHECK_MS + 1)
		).to.equal(false);
	});
});

describe('rebuildRetryDelayMs — the wake a denied rebuild needs', () => {
	it('is zero when nothing is holding the rebuild back', () => {
		expect(rebuildRetryDelayMs(false, 0, 0, NOW)).to.equal(0);
	});

	it('reports the remaining floor for a torn tail', () => {
		// Without this wake the loop parks on `nextTransaction` after a denied rebuild, so the write that
		// finally makes the tail readable can arrive inside the floor, be denied, and then need ANOTHER
		// commit — which a quiet writer never sends. That is the original wedge, reached through the floor.
		expect(rebuildRetryDelayMs(false, NOW, NOW, NOW + 10_000)).to.equal(SEND_LOG_REPAIR_INTERVAL_MS - 10_000);
		expect(rebuildRetryDelayMs(false, NOW, NOW, NOW + SEND_LOG_REPAIR_INTERVAL_MS)).to.equal(0);
	});

	it('reports the remaining quarantine window for a mid-log break', () => {
		expect(rebuildRetryDelayMs(true, NOW, 0, NOW)).to.equal(SEND_LOG_QUARANTINE_RECHECK_MS);
	});

	it('agrees with mayRebuildSendRange: zero delay exactly when a rebuild is allowed', () => {
		for (const midLog of [false, true]) {
			for (const elapsed of [0, 1_000, SEND_LOG_REPAIR_INTERVAL_MS, SEND_LOG_QUARANTINE_RECHECK_MS]) {
				const at = NOW + elapsed;
				expect(rebuildRetryDelayMs(midLog, NOW, NOW, at) === 0).to.equal(
					mayRebuildSendRange(midLog, NOW, NOW, at),
					`midLog=${midLog} elapsed=${elapsed}`
				);
			}
		}
	});
});

describe('claimRecoveryCloseInSharedStatus', () => {
	it('shares the episode budget across status views', () => {
		const buffer = new ArrayBuffer(REPLICATION_SHARED_STATUS_SLOTS * Float64Array.BYTES_PER_ELEMENT);
		const firstWorker = new Float64Array(buffer);
		const secondWorker = new Float64Array(buffer);
		expect(claimRecoveryCloseInSharedStatus(firstWorker, NOW, INTERVAL, 3).allowed).to.equal(true);
		expect(claimRecoveryCloseInSharedStatus(firstWorker, NOW + INTERVAL, INTERVAL, 3).allowed).to.equal(true);
		expect(claimRecoveryCloseInSharedStatus(secondWorker, NOW + 2 * INTERVAL, INTERVAL, 3).allowed).to.equal(true);
		expect(claimRecoveryCloseInSharedStatus(secondWorker, NOW + 3 * INTERVAL, INTERVAL, 3).allowed).to.equal(false);
	});

	it('keeps the shared close floor when a worker is denied', () => {
		const status = new Float64Array(REPLICATION_SHARED_STATUS_SLOTS);
		expect(claimRecoveryCloseInSharedStatus(status, NOW, INTERVAL, 3).allowed).to.equal(true);
		expect(claimRecoveryCloseInSharedStatus(status, NOW + 1_000, INTERVAL, 3).allowed).to.equal(false);
		expect(status[DECODE_DROP_LAST_CLOSE_POSITION]).to.equal(NOW);
		expect(claimRecoveryCloseInSharedStatus(status, NOW + INTERVAL - 1, INTERVAL, 3).allowed).to.equal(false);
	});

	it('retains a granted claim after a worker cannot close its socket', () => {
		const status = new Float64Array(REPLICATION_SHARED_STATUS_SLOTS);
		status[DECODE_DROP_LAST_CLOSE_POSITION] = NOW - INTERVAL;
		status[DECODE_DROP_CLOSE_COUNT_POSITION] = 1;
		status[DECODE_DROP_LAST_EVENT_POSITION] = NOW - INTERVAL;
		const claim = claimRecoveryCloseInSharedStatus(status, NOW, INTERVAL, 3);
		expect(claim.allowed).to.equal(true);
		expect(status[DECODE_DROP_LAST_CLOSE_POSITION]).to.equal(NOW);
		expect(status[DECODE_DROP_CLOSE_COUNT_POSITION]).to.equal(2);
		expect(status[DECODE_DROP_LAST_EVENT_POSITION]).to.equal(NOW);
	});
});
