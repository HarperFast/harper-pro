/**
 * The bound on the decode-drop structure resync (harper-pro#810).
 *
 * That close ENDS the session that decided to make it, so its bound cannot live on the session: a
 * session-scoped latch resets on the very reconnect it caused and bounds nothing. It lives in a module
 * map keyed by (database, peer), and the predicates below are pure so it can be pinned without a live
 * socket.
 *
 * The send-log-break repair needs none of this: it replaces a cached local rather than closing anything,
 * so session-local interval floors are the whole bound — `mayRebuildSendRange` below.
 */

import { expect } from 'chai';
import {
	claimRecoveryClose,
	mayRebuildSendRange,
	rebuildRetryDelayMs,
	SEND_LOG_REPAIR_INTERVAL_MS,
	SEND_LOG_QUARANTINE_RECHECK_MS,
	recoveryCloseAllowed,
	recoveryCloseEpisodeCount,
	RECOVERY_CLOSE_EPISODE_MS,
	DECODE_DROP_RESYNC_BUDGET,
} from '#src/replication/replicationConnection';

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

	it('lets a spent budget lapse when the caller only RE-ASKS about a condition it already reported', () => {
		// A latched send iterable reports the same `breaks` on every wake. If those re-asks stamped
		// `lastEventAt`, the episode could never lapse, so a budget once spent would never be restored and
		// the leg could never recover — not even after the log was repaired. Only a NEW break feeds the
		// bound; a re-ask consults it. Modelled here as "the last event is old": that is the state a
		// re-asking caller leaves behind, and the budget comes back.
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

describe('claimRecoveryClose — the interaction a denied claim used to poison', () => {
	const KEY = 'data\u0000peer-a';
	const INTERVAL_MS = 5 * 60_000;
	const BUDGET = 3;
	const claim = (bounds, now, isNewEvent) => claimRecoveryClose(bounds, KEY, now, INTERVAL_MS, BUDGET, isNewEvent);

	it('allows the first claim and denies a second inside the interval', () => {
		const bounds = new Map();
		expect(claim(bounds, NOW, true).allowed).to.equal(true);
		expect(claim(bounds, NOW + 1_000, true).allowed).to.equal(false);
	});

	it('re-asking about a condition already reported does NOT hold the episode open', () => {
		// The defect this pins: a latched send iterable reports the same `breaks` forever, so the caller has
		// to keep asking. If those re-asks stamped the episode, a spent budget could never lapse and the leg
		// would sit silent at connected:true/WAITING for the life of the session — the exact wedge this net
		// exists to end, reached through its own bound.
		const bounds = new Map();
		for (let i = 0; i < BUDGET; i++) claim(bounds, NOW + i * INTERVAL_MS, true);
		expect(claim(bounds, NOW + BUDGET * INTERVAL_MS, true).allowed).to.equal(false);

		const lastNewEventAt = bounds.get(KEY).lastEventAt;
		// Re-asks INSIDE the episode are denied and must not move the episode clock, or it never lapses.
		for (let i = 1; i <= 10; i++) {
			const at = lastNewEventAt + i * (RECOVERY_CLOSE_EPISODE_MS / 20);
			expect(claim(bounds, at, false).allowed).to.equal(false);
			expect(bounds.get(KEY).lastEventAt).to.equal(lastNewEventAt);
		}

		// Once it lapses, the next re-ask is allowed: the escape hatch is reachable without a new event.
		expect(claim(bounds, lastNewEventAt + RECOVERY_CLOSE_EPISODE_MS, false).allowed).to.equal(true);
		// And that close anchors the episode to itself, so the restored budget is a real budget again rather
		// than one close per interval forever: the three it allows put the caller back into the spent state.
		const armedAt = lastNewEventAt + RECOVERY_CLOSE_EPISODE_MS;
		expect(bounds.get(KEY).lastEventAt).to.equal(armedAt);
		expect(claim(bounds, armedAt + INTERVAL_MS / 2, false).allowed).to.equal(false);
		expect(claim(bounds, armedAt + INTERVAL_MS, false).allowed).to.equal(true);
		expect(claim(bounds, armedAt + 2 * INTERVAL_MS, false).allowed).to.equal(true);
		expect(claim(bounds, armedAt + 3 * INTERVAL_MS, false).allowed).to.equal(false);
	});

	it('keeps a spent budget spent while NEW events keep arriving', () => {
		// The other half: a fault that keeps producing breaks must stay isolated rather than being handed a
		// fresh budget every quiet hour.
		const bounds = new Map();
		for (let i = 0; i < BUDGET; i++) claim(bounds, NOW + i * INTERVAL_MS, true);
		let at = NOW + BUDGET * INTERVAL_MS;
		for (let i = 0; i < 20; i++) {
			at += RECOVERY_CLOSE_EPISODE_MS / 2;
			expect(claim(bounds, at, true).allowed).to.equal(false);
		}
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

describe('claimRecoveryClose rollback — a slot spent on a close that never happened', () => {
	it('restores the previous bound exactly', () => {
		const bounds = new Map();
		const KEY = 'data\u0000peer-b';
		const first = claimRecoveryClose(bounds, KEY, NOW, INTERVAL, 3, true);
		expect(first.allowed).to.equal(true);
		const afterFirst = { ...bounds.get(KEY) };

		const second = claimRecoveryClose(bounds, KEY, NOW + INTERVAL, 3, 3, true);
		expect(second.allowed).to.equal(true);
		second.rollback();
		expect({ ...bounds.get(KEY) }).to.deep.equal(afterFirst);
	});

	it('removes the entry entirely when the claim created it', () => {
		const bounds = new Map();
		const KEY = 'data\u0000peer-c';
		claimRecoveryClose(bounds, KEY, NOW, INTERVAL, 3, true).rollback();
		expect(bounds.has(KEY)).to.equal(false);
	});
});
