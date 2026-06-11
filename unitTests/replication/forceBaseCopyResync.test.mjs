/**
 * Coverage for the sender-side retention decision behind harper-pro#277. When a peer's requested
 * incremental replication start predates the transaction-log history the sender still retains (audit
 * retention is time-based), incremental replay can no longer serve it without silently skipping
 * purged entries or replaying an unbounded history (the heap-unbounded path that OOMs, harper#1114).
 * shouldForceBaseCopyForRetention is the pure decision that upgrades such a start to the bounded
 * base-copy path (startTime = 0). The retention floor is max(oldestRetainedEntry, now - retention),
 * so it catches both purges more aggressive than nominal retention and a fully-purged/idle log.
 */

import { expect } from 'chai';
import { shouldForceBaseCopyForRetention } from '#src/replication/replicationConnection';

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
});
