/**
 * Coverage for the sender-side retention decision behind harper-pro#277. When a peer's requested
 * incremental replication start predates the transaction-log history the sender still retains (audit
 * retention is time-based), incremental replay can no longer serve it without silently skipping
 * purged entries or replaying an unbounded history (the heap-unbounded path that OOMs, harper#1114).
 * shouldForceBaseCopyForRetention is the pure decision that upgrades such a start to the bounded
 * base-copy path (startTime = 0). Without a purge bound from the source the floor is
 * max(oldestRetainedEntry, now - retention, audit floor); with one, the start is compared against it alone.
 */

import { expect } from 'chai';
import {
	shouldForceBaseCopyForRetention,
	purgeBoundLogNames,
	replayStartUnderPurge,
	predatesPurgeTracking,
	retentionResumeDecision,
	retainedLogCoversStart,
	receiverRefusesCopies,
	shouldWarnUnvouchedReplay,
	ORIGIN_CURSOR_OVERLAP_MS,
} from '#src/replication/replicationConnection';

describe('shouldForceBaseCopyForRetention', () => {
	const RETENTION = 3 * 86400 * 1000; // 3 days, like the incident's auditRetention

	it('forces a base copy when the requested start predates the oldest retained entry', () => {
		// oldest retained entry (5000) is newer than the cutoff (3000): purge ran more aggressively
		// than nominal retention, so the actual retained floor is the oldest entry.
		expect(shouldForceBaseCopyForRetention(1000, 5000, 3000)).to.equal(true);
	});

	it('forces a base copy when the requested start predates the retention cutoff even with an empty/idle log', () => {
		// No retained audit entry (log fully purged or idle) but the requested start is older than the
		// retention window — the data still lives in the primary store, so we must base-copy it.
		expect(shouldForceBaseCopyForRetention(1000, undefined, 3000)).to.equal(true);
	});

	it('forces a base copy for a far-behind peer using a realistic retention window', () => {
		const now = Date.now();
		const threeWeeksBehind = now - 21 * 86400 * 1000; // the system-DB incident: ~3 weeks behind
		const oldestRetained = now - RETENTION; // everything older was purged
		expect(shouldForceBaseCopyForRetention(threeWeeksBehind, oldestRetained, now - RETENTION)).to.equal(true);
	});

	it('does NOT force a base copy when the requested start is at or after the oldest retained entry', () => {
		// Requested start equals the oldest retained entry — incremental replay (exclusiveStart) has no gap.
		expect(shouldForceBaseCopyForRetention(5000, 5000, 3000)).to.equal(false);
		// Requested start newer than both floors.
		expect(shouldForceBaseCopyForRetention(10000, 5000, 3000)).to.equal(false);
	});

	it('does NOT force a base copy for a peer that is only slightly behind, within retention', () => {
		const now = Date.now();
		const oneHourBehind = now - 3600 * 1000;
		const oldestRetained = now - RETENTION;
		expect(shouldForceBaseCopyForRetention(oneHourBehind, oldestRetained, now - RETENTION)).to.equal(false);
	});

	it('does NOT force a base copy for a brand-new node (empty log, recent requested start)', () => {
		const now = Date.now();
		const freshStart = now - 60000; // requester default when starting from scratch (non-leader)
		expect(shouldForceBaseCopyForRetention(freshStart, undefined, now - RETENTION)).to.equal(false);
	});

	it('does not treat a base-copy request (0) or invalid start as a forced upgrade', () => {
		// 0 already means base copy was requested; must not double-handle.
		expect(shouldForceBaseCopyForRetention(0, 5000, 3000)).to.equal(false);
		// Defensive: non-positive / NaN starts never force.
		expect(shouldForceBaseCopyForRetention(-1, 5000, 3000)).to.equal(false);
		expect(shouldForceBaseCopyForRetention(Number.NaN, 5000, 3000)).to.equal(false);
	});

	describe('with a purge bound from the source (harper-pro#1229)', () => {
		const now = Date.now();
		const cutoff = now - RETENTION;
		const forced = (start, bound) => replayStartUnderPurge(['local'], start, undefined, () => bound) !== undefined;

		it('does NOT force a follower caught up on an idle source whose log was purged empty', () => {
			const lastWrite = now - 5 * 86400 * 1000; // idle five days, past the three-day retention
			expect(forced(lastWrite, lastWrite)).to.equal(false);
		});

		it('does NOT force a follower of a log that was never written', () => {
			const tracked = now - 10 * 86400 * 1000; // the floor when tracking began
			expect(forced(now - 4 * 86400 * 1000, tracked)).to.equal(false);
		});

		it('forces a follower that missed entries a prune removed, even with the log now empty', () => {
			expect(forced(now - 6 * 86400 * 1000, now - 5 * 86400 * 1000)).to.equal(true);
		});

		it('forces a follower behind a manual purge whose cutoff is past nominal retention', () => {
			// delete_transaction_logs_before at now - 1h emptied a log written until then; the follower is at now - 2h
			expect(forced(now - 2 * 3600 * 1000, now - 3600 * 1000)).to.equal(true);
		});

		it('falls back to the audit floor when the store has no trusted bound', () => {
			// no bound: a manual purge past nominal retention is still caught through the floor it recorded
			expect(shouldForceBaseCopyForRetention(now - 7200_000, undefined, cutoff, now - 3600_000)).to.equal(true);
			// an unknown floor (Infinity) is ignored, leaving the oldest entry and nominal cutoff
			expect(shouldForceBaseCopyForRetention(now - 3600_000, undefined, cutoff, Infinity)).to.equal(false);
		});
	});

	describe('purgeBoundLogNames', () => {
		const store = {
			loadLogs: () => [{ name: 'local' }, undefined, { name: 'node-b' }, { name: 'node-c' }],
		};

		it('names only the subscribed log for a single-log subscription', () => {
			expect(purgeBoundLogNames(store, 'node-b', ['node-c'])).to.deep.equal(['node-b']);
		});

		it('names every log the aggregate range does not exclude', () => {
			expect(purgeBoundLogNames(store, undefined, ['node-c'])).to.deep.equal(['local', 'node-b']);
		});

		it('leaves an engine with no per-origin logs to the store', () => {
			expect(purgeBoundLogNames({}, undefined, [])).to.equal(undefined);
		});
	});
});

describe('replayStartUnderPurge', () => {
	const bounds = { local: 900, relayed: 3000, quiet: 100 };
	const boundOf = (name) => bounds[name];

	// a follower's resume floor for an origin is its cursor less the overlap
	const floorAt = (cursor) => new Map([['relayed', cursor - ORIGIN_CURSOR_OVERLAP_MS]]);

	it('compares a relayed origin with a resume floor from its cursor, not from the merged start', () => {
		// the merged start (1000) is under `relayed`'s bound, but the follower holds `relayed` through 4940
		expect(replayStartUnderPurge(['local', 'relayed'], 1000, floorAt(4940), boundOf)).to.equal(undefined);
		// a prune removed `relayed` past the follower's cursor, though the merged start is past every bound
		expect(replayStartUnderPurge(['local', 'relayed'], 5000, floorAt(2000), boundOf)).to.deep.equal({
			log: 'relayed',
			start: 2000,
			bound: 3000,
		});
	});

	it("forces nothing for a relayed origin whose last key sits inside the floor's overlap", () => {
		// an idle origin's bound is its last key, which the follower's cursor reached
		expect(replayStartUnderPurge(['relayed'], 5000, floorAt(3000), boundOf)).to.equal(undefined);
	});

	it('compares every other log from the merged start', () => {
		expect(replayStartUnderPurge(['local', 'quiet'], 950, undefined, boundOf)).to.equal(undefined);
		expect(replayStartUnderPurge(['local', 'quiet'], 800, undefined, boundOf)).to.deep.equal({
			log: 'local',
			start: 800,
			bound: 900,
		});
	});

	it('forces a copy for a log whose bound cannot be read', () => {
		expect(replayStartUnderPurge(['unknown'], 5000, undefined, boundOf)).to.deep.equal({
			log: 'unknown',
			start: 5000,
			bound: undefined,
		});
	});
});

describe('predatesPurgeTracking', () => {
	const TRACKED_FROM = 5000;
	const subscriptions = (own, proxied) => [
		{ name: 'relay', startTime: own },
		{ name: 'proxied', startTime: proxied },
	];

	it("compares the follower's start on this node", () => {
		expect(predatesPurgeTracking(subscriptions(5000, 6000), 'relay', 5000, TRACKED_FROM)).to.equal(false);
		expect(predatesPurgeTracking(subscriptions(4999, 6000), 'relay', 4999, TRACKED_FROM)).to.equal(true);
	});

	it("ignores a listed proxied origin's older start, which is that origin's key", () => {
		expect(predatesPurgeTracking(subscriptions(5000, 100), 'relay', 100, TRACKED_FROM)).to.equal(false);
	});

	it('falls back to the merged start when the follower does not list this node', () => {
		expect(predatesPurgeTracking([{ name: 'proxied', startTime: 100 }], 'relay', 100, TRACKED_FROM)).to.equal(true);
		expect(predatesPurgeTracking([{ name: 'proxied', startTime: 6000 }], 'relay', 6000, TRACKED_FROM)).to.equal(false);
	});
});

describe('retentionResumeDecision', () => {
	it('replays a start this node can vouch for on any route', () => {
		expect(retentionResumeDecision(false, false, false, false)).to.equal('replay');
		expect(retentionResumeDecision(false, false, false, true)).to.equal('replay');
	});

	it('copies an unvouched start for a receiver that can take the copy', () => {
		expect(retentionResumeDecision(false, false, true, false)).to.equal('copy');
		expect(retentionResumeDecision(false, true, false, false)).to.equal('copy');
	});

	it('never copies to a receiver owning slots this node cannot copy, which would refuse it (harper-pro#1278)', () => {
		expect(retentionResumeDecision(false, false, true, true)).to.equal('replay-unvouched');
		expect(retentionResumeDecision(false, true, false, true)).to.equal('replay-unvouched');
		expect(retentionResumeDecision(false, true, true, true)).to.equal('replay-unvouched');
	});

	it('still copies under the test hook, which exercises the refusal', () => {
		expect(retentionResumeDecision(true, false, false, true)).to.equal('copy');
		expect(retentionResumeDecision(true, false, false, false)).to.equal('copy');
		expect(retentionResumeDecision(true, false, true, false, true)).to.equal('copy');
	});

	it('replays a covered start to a receiver that can only take a verified legacy copy', () => {
		expect(retentionResumeDecision(false, false, true, false, true)).to.equal('replay-retained');
		expect(retentionResumeDecision(false, false, true, true, true)).to.equal('replay-retained');
		expect(retentionResumeDecision(false, false, false, false, true)).to.equal('replay');
	});

	it('does not replay a covered start certified under another generation', () => {
		expect(retentionResumeDecision(false, true, true, false, true)).to.equal('copy');
		expect(retentionResumeDecision(false, true, true, true, true)).to.equal('replay-unvouched');
	});
});

describe('retainedLogCoversStart', () => {
	const TRACKED_FROM = 10_000;
	const LOGS = ['local'];
	const atTracking = () => TRACKED_FROM;
	const covers = (overrides = {}) => {
		const { start, oldest, trackedFrom, logs, boundOf, singleLog } = {
			start: 6000,
			oldest: 1000,
			trackedFrom: TRACKED_FROM,
			logs: LOGS,
			boundOf: atTracking,
			singleLog: true,
			...overrides,
		};
		return retainedLogCoversStart(start, oldest, trackedFrom, logs, boundOf, singleLog);
	};

	it('covers a start below tracking when the retained log reaches back to it and no prune passed tracking', () => {
		expect(covers()).to.equal(true);
		expect(covers({ oldest: 6000 })).to.equal(true);
	});

	it('does not cover when the retained log starts after the follower', () => {
		expect(covers({ oldest: 6001 })).to.equal(false);
		expect(covers({ oldest: undefined })).to.equal(false);
	});

	it('does not cover once a tracked prune bound passes where tracking began', () => {
		expect(covers({ boundOf: () => TRACKED_FROM + 1 })).to.equal(false);
	});

	it('fails closed on a log whose bound cannot be read', () => {
		expect(covers({ boundOf: () => undefined })).to.equal(false);
		expect(
			covers({ logs: ['local', 'other'], boundOf: (name) => (name === 'local' ? TRACKED_FROM : undefined) })
		).to.equal(false);
	});

	it('only covers a start that predates tracking', () => {
		expect(covers({ start: TRACKED_FROM })).to.equal(false);
		expect(covers({ trackedFrom: undefined })).to.equal(false);
		expect(covers({ start: 0 })).to.equal(false);
	});

	it('never covers a store with more than one log', () => {
		expect(covers({ singleLog: false })).to.equal(false);
	});
});

describe('shouldWarnUnvouchedReplay', () => {
	it('warns once per database, peer and reason', () => {
		expect(shouldWarnUnvouchedReplay('warn-db', 'peer-a', 'under bound 1')).to.equal(true);
		expect(shouldWarnUnvouchedReplay('warn-db', 'peer-a', 'under bound 1')).to.equal(false);
		expect(shouldWarnUnvouchedReplay('warn-db', 'peer-b', 'under bound 1')).to.equal(true);
		expect(shouldWarnUnvouchedReplay('other-db', 'peer-a', 'under bound 1')).to.equal(true);
		expect(shouldWarnUnvouchedReplay('warn-db', 'peer-a', 'under bound 2')).to.equal(true);
		expect(shouldWarnUnvouchedReplay('warn-db', 'peer-a', 'under bound 2')).to.equal(false);
	});
});

describe('receiverRefusesCopies', () => {
	it("takes the receiver's declaration for this node over the inference", () => {
		expect(receiverRefusesCopies([{ name: 'me', refusesCopies: false }], 'me', true)).to.equal(false);
		expect(receiverRefusesCopies([{ name: 'me', refusesCopies: true }], 'me', false)).to.equal(true);
	});

	it('infers for a receiver too old to declare, or with no entry for this node', () => {
		expect(receiverRefusesCopies([{ name: 'me' }], 'me', true)).to.equal(true);
		expect(receiverRefusesCopies([{ name: 'other', refusesCopies: true }], 'me', false)).to.equal(false);
	});
});
