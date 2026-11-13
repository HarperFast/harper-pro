/**
 * Own-origin recovery's decisions without a cluster: where an epoch's window starts, when a peer's report
 * proves own lineage, which subscription a sender treats as a recovery range, and the coalesced flush.
 */
import assert from 'node:assert';
import { flushAfterNow, lineageFromReports, nextEpoch, recoveryStart } from '#src/replication/ownOriginRecovery';
import { findOwnOriginRecoveryRange, ORIGIN_CURSOR_OVERLAP_MS } from '#src/replication/replicationConnection';
import {
	buildLocalCapabilities,
	peerSupportsOwnOriginRecovery,
	resolvePeerCapabilities,
} from '#src/replication/protocolCapabilities';

const NOW = 1_800_000_000_000;

describe('recoveryStart', () => {
	it('starts the commit-order overlap below the last key, since an entry can append after a higher key', () => {
		assert.strictEqual(recoveryStart(NOW, undefined, undefined), NOW - ORIGIN_CURSOR_OVERLAP_MS);
	});
	it('starts at 1 when the log holds nothing: an empty log does not prove nothing was lost', () => {
		assert.strictEqual(recoveryStart(undefined, undefined, undefined), 1);
		assert.strictEqual(recoveryStart(0, undefined, undefined), 1);
	});
	it('uses the purge bound when retention emptied the log', () => {
		assert.strictEqual(recoveryStart(undefined, NOW, undefined), NOW - ORIGIN_CURSOR_OVERLAP_MS);
		assert.strictEqual(recoveryStart(NOW - 5, NOW, undefined), NOW - ORIGIN_CURSOR_OVERLAP_MS);
	});
	it("keeps an unfinished earlier epoch's start, and drops a finished one's", () => {
		const earlier = { after: NOW - 3_600_000, lastKey: 0, before: NOW - 1_000, requiredPeers: [] };
		assert.strictEqual(recoveryStart(NOW, undefined, earlier), earlier.after);
		assert.strictEqual(recoveryStart(NOW, undefined, { ...earlier, finished: true }), NOW - ORIGIN_CURSOR_OVERLAP_MS);
	});
});

describe('nextEpoch', () => {
	it('judges an unfinished window against what the log held when it opened, so a restart cannot clear a purge gap', () => {
		const earlier = { after: NOW - 60_000, lastKey: NOW, before: NOW + 1_000, requiredPeers: [] };
		const next = nextEpoch(NOW + 5_000, undefined, earlier, NOW + 10_000, ['b']);
		assert.deepStrictEqual(next, { after: earlier.after, lastKey: NOW, before: NOW + 10_000, requiredPeers: ['b'] });
		assert.strictEqual(
			nextEpoch(NOW + 5_000, undefined, { ...earlier, finished: true }, NOW + 10_000, []).lastKey,
			NOW + 5_000
		);
	});
});

describe('lineageFromReports', () => {
	const epoch = { after: NOW - 60_000, lastKey: NOW, before: NOW + 10_000, requiredPeers: ['b', 'c'] };
	const member = () => true;
	const clean = { epoch: epoch.before };

	it('is intact once every required peer and every lock home reported cleanly for this epoch', () => {
		const reports = { b: clean, c: clean, d: clean };
		assert.deepStrictEqual(
			lineageFromReports(epoch, ['self', 'd'], 'self', (p) => reports[p], member),
			{
				state: 'intact',
			}
		);
	});
	it('waits on a missing report, a report from an earlier epoch, and a home that is not a cursor peer', () => {
		assert.strictEqual(
			lineageFromReports(epoch, [], 'self', (p) => (p === 'b' ? clean : undefined), member).state,
			'pending'
		);
		const stale = { b: clean, c: { epoch: epoch.before - 1 } };
		assert.strictEqual(lineageFromReports(epoch, [], 'self', (p) => stale[p], member).state, 'pending');
		const peersOnly = { b: clean, c: clean };
		assert.strictEqual(lineageFromReports(epoch, ['d'], 'self', (p) => peersOnly[p], member).state, 'pending');
	});
	it('is unprovable when a peer could not read the log or purged past everything this node still held', () => {
		const failed = { b: clean, c: { epoch: epoch.before, failed: true } };
		assert.strictEqual(lineageFromReports(epoch, [], 'self', (p) => failed[p], member).state, 'unprovable');
		const purged = { b: clean, c: { epoch: epoch.before, purgedThrough: NOW + 1 } };
		assert.strictEqual(lineageFromReports(epoch, [], 'self', (p) => purged[p], member).state, 'unprovable');
	});
	it('accepts a purge that stopped at or below what this node held', () => {
		const purged = { b: clean, c: { epoch: epoch.before, purgedThrough: NOW } };
		assert.strictEqual(lineageFromReports(epoch, [], 'self', (p) => purged[p], member).state, 'intact');
	});
	it('skips removed members and this node itself', () => {
		const reports = { b: clean };
		assert.strictEqual(
			lineageFromReports(
				{ ...epoch, requiredPeers: ['b', 'c', 'self'] },
				[],
				'self',
				(p) => reports[p],
				(p) => p !== 'c'
			).state,
			'intact'
		);
	});
	it('a finished epoch still waits on a lock home that is not a cursor peer', () => {
		const reports = { b: clean, c: clean };
		assert.strictEqual(
			lineageFromReports({ ...epoch, finished: true }, ['d'], 'self', (p) => reports[p], member).state,
			'pending'
		);
	});
	it('names each peer it found clean, so the caller can stop reading it', () => {
		const seen = [];
		lineageFromReports(
			epoch,
			[],
			'self',
			() => clean,
			member,
			(peer) => seen.push(peer)
		);
		assert.deepStrictEqual(seen, ['b', 'c']);
	});
});

describe('findOwnOriginRecoveryRange', () => {
	const range = { name: 'receiver', startTime: NOW - 60_000, endTime: NOW };
	const subscriptions = [{ name: 'sender', startTime: NOW - 5_000 }, range];
	it("finds the receiver's own bounded range from a receiver with the capability", () => {
		assert.strictEqual(findOwnOriginRecoveryRange(subscriptions, 'receiver', true), range);
	});
	it("leaves an older receiver's failover self catch-up, another node's range, and an unbounded one alone", () => {
		assert.strictEqual(findOwnOriginRecoveryRange(subscriptions, 'receiver', false), undefined);
		assert.strictEqual(findOwnOriginRecoveryRange(subscriptions, 'other', true), undefined);
		assert.strictEqual(
			findOwnOriginRecoveryRange([{ name: 'receiver', startTime: NOW - 60_000 }], 'receiver', true),
			undefined
		);
		assert.strictEqual(
			findOwnOriginRecoveryRange([{ name: 'receiver', startTime: NOW, endTime: NOW }], 'receiver', true),
			undefined
		);
	});
	it('accepts a range starting at 1, which an empty log asks for', () => {
		const fromOne = { name: 'receiver', startTime: 1, endTime: NOW };
		assert.strictEqual(findOwnOriginRecoveryRange([fromOne], 'receiver', true), fromOne);
	});
});

describe('ownOriginRecovery capability', () => {
	it('is advertised only with per-origin logs and resolved from the peer bag', () => {
		assert.strictEqual(buildLocalCapabilities(1000, false, true).ownOriginRecovery, 1);
		assert.strictEqual(buildLocalCapabilities(1000, false, false).ownOriginRecovery, 0);
		assert.strictEqual(peerSupportsOwnOriginRecovery(resolvePeerCapabilities({ ownOriginRecovery: 1 })), true);
		assert.strictEqual(peerSupportsOwnOriginRecovery(resolvePeerCapabilities({})), false);
	});
});

describe('flushAfterNow', () => {
	it('starts a flush for the first caller and shares one later flush among callers arriving meanwhile', async () => {
		const pending = [];
		const store = { flush: () => new Promise((resolve) => pending.push(resolve)) };
		const first = flushAfterNow(store);
		await Promise.resolve();
		const second = flushAfterNow(store);
		const third = flushAfterNow(store);
		assert.strictEqual(second, third);
		assert.strictEqual(pending.length, 1);
		pending[0]();
		await first;
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(pending.length, 2, 'the waiters get a flush that began after they called');
		pending[1]();
		await second;
	});
	it('a failed flush rejects its callers and does not block the next one', async () => {
		let calls = 0;
		const store = {
			flush: () => (++calls === 1 ? Promise.reject(new Error('stall')) : Promise.resolve()),
		};
		await assert.rejects(flushAfterNow(store), /stall/);
		await flushAfterNow(store);
		assert.strictEqual(calls, 2);
	});
});
