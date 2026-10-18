/**
 * The send-log-break repair replaces a cached local rather than closing anything, so session-local
 * interval floors are the whole bound — `mayRebuildSendRange` below.
 */

import { expect } from 'chai';
import {
	mayRebuildSendRange,
	rebuildRetryDelayMs,
	resolveSendRangeSeed,
	sendLogBreakCommitTransition,
	sendLogBreakRepairDecision,
	SEND_LOG_REPAIR_INTERVAL_MS,
	SEND_LOG_QUARANTINE_RECHECK_MS,
} from '#src/replication/replicationConnection';

const NOW = 1_000_000_000;

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
		// after an operator repairs the log.
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

describe('sendLogBreakRepairDecision', () => {
	it('establishes the clock and quarantine wake before diagnostics run', () => {
		expect(sendLogBreakRepairDecision(true, 0, 0, NOW)).to.deep.equal({
			breakSince: NOW,
			rebuild: false,
			retryInMs: SEND_LOG_QUARANTINE_RECHECK_MS,
		});
	});
});

describe("resolveSendRangeSeed — the named origin cannot be seeded from another origin's progress", () => {
	it('seeds an ordinary rebuild from currentSequenceId, exactly as before this fix', () => {
		expect(resolveSendRangeSeed(false, undefined, 500)).to.equal(500);
		expect(resolveSendRangeSeed(false, 999, 500)).to.equal(500);
	});

	it('floors an ordinary rebuild at 1, not 0 — exclusiveStart:true on 0 would still exclude key 0', () => {
		expect(resolveSendRangeSeed(false, undefined, 0)).to.equal(1);
	});

	it('a failure-triggered rebuild reuses the preserved per-origin bound, not the scalar', () => {
		// The scenario this exists for: a relayed origin pushed the merged scalar to 1000 while THIS
		// origin's own last proven-safe position was only 100 — seeding from 1000 would skip its
		// still-undelivered entry at (say) 200 forever.
		expect(resolveSendRangeSeed(true, 100, 1000)).to.equal(100);
	});

	it('a failure-triggered rebuild with no preserved bound falls back to zero, never the scalar', () => {
		// Matches core's own default for any log absent from `startByLog` (RocksTransactionLogStore.ts):
		// a full re-scan from zero is wasteful but safe (existing duplicate handling absorbs it),
		// unlike seeding from a scalar that may already be past this origin's own undelivered entries.
		expect(resolveSendRangeSeed(true, undefined, 1000)).to.equal(0);
	});

	it('a failure-triggered rebuild never reads the scalar at all, even when it is lower than the preserved bound', () => {
		// Proves the fix does not merely "prefer the lower of the two" — it must ignore the scalar
		// outright once a failure is in play, since the scalar's only property that ever mattered
		// (being a safe lower bound for THIS origin) is exactly what a merged range can violate.
		expect(resolveSendRangeSeed(true, 500, 100)).to.equal(500);
	});
});

describe('sendLogBreakCommitTransition — whether a denied torn-tail rebuild has seen a commit', () => {
	// A plain object stands in for a pending-transaction promise: only identity matters here, never value.
	const P1 = {};
	const P2 = {};

	it('the first deny of a break episode records the pending generation without observing a commit', () => {
		expect(sendLogBreakCommitTransition(undefined, false, P1)).to.deep.equal({
			firstPendingAtDeny: P1,
			commitObserved: false,
		});
	});

	it('a later deny on the SAME pending generation has not seen a commit', () => {
		expect(sendLogBreakCommitTransition(P1, false, P1)).to.deep.equal({
			firstPendingAtDeny: P1,
			commitObserved: false,
		});
	});

	it('a later deny on a DIFFERENT pending generation means a commit landed in between', () => {
		expect(sendLogBreakCommitTransition(P1, false, P2)).to.deep.equal({
			firstPendingAtDeny: P1,
			commitObserved: true,
		});
	});

	it('stays observed on a later deny even if the generation reverts to matching the first-seen one again', () => {
		// Regression (round 5/6): re-deriving "has anything changed" only against the IMMEDIATELY
		// PRECEDING deny, rather than a sticky flag, forgot a commit the moment an intervening non-commit
		// wake (re-admission, supersession) interrupted an armed wait and the next deny's comparison came
		// up empty — reverting to a timerless wait that could then wedge forever on a quiet tail.
		expect(sendLogBreakCommitTransition(P1, true, P1)).to.deep.equal({
			firstPendingAtDeny: P1,
			commitObserved: true,
		});
	});

	it("a reset episode is not contaminated by the PRIOR episode's commitObserved history", () => {
		// The reset itself happens at the call site (`repairSendLogBreak`'s granted branch sets both
		// fields back to their initial values), not inside this function — what this proves is that
		// a reset episode behaves exactly like a brand-new one afterward, not like a continuation of
		// the old one. Without the reset, a prior episode's `commitObserved: true` would stay stuck
		// sticky forever, masking whether a commit has actually landed in the NEW episode.
		const priorEpisodeEndedWithCommitObserved = sendLogBreakCommitTransition(P1, false, P2);
		expect(priorEpisodeEndedWithCommitObserved.commitObserved).to.equal(true);
		const reset = { firstPendingAtDeny: undefined, commitObserved: false };
		const freshEpisodeFirstDeny = sendLogBreakCommitTransition(
			reset.firstPendingAtDeny,
			reset.commitObserved,
			P1
		);
		expect(freshEpisodeFirstDeny).to.deep.equal({ firstPendingAtDeny: P1, commitObserved: false });
	});
});
