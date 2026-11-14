/**
 * Own-origin recovery's decisions without a cluster: where an epoch's window starts, when a peer's report
 * proves own lineage, which subscription a sender treats as a recovery range, and the coalesced flush.
 */
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { table } from '#src/core/resources/databases';
import {
	continuesEpoch,
	flushAfterNow,
	lineageFromReports,
	markOwnOriginRecoveryFailed,
	nextEpoch,
	openOwnOriginRecoveryEpoch,
	UNPROVEN_RECHECK_MS,
	ownLineage,
	recoveryRangeFor,
	recoveryStart,
} from '#src/replication/ownOriginRecovery';
import {
	findOwnOriginRecoveryRange,
	ORIGIN_CURSOR_OVERLAP_MS,
	returnedByOwnOriginRecovery,
} from '#src/replication/replicationConnection';
import {
	buildLocalCapabilities,
	peerSupportsOwnOriginRecovery,
	resolvePeerCapabilities,
} from '#src/replication/protocolCapabilities';

const NOW = 1_800_000_000_000;
const { setupTestDBPath } = createRequire(import.meta.url)('../testUtils.js');

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

describe('nextEpoch required peers', () => {
	it('an unfinished epoch keeps waiting on every holder it named, even one no longer found', () => {
		const previous = { after: 1, lastKey: 5, before: NOW - 1000, requiredPeers: ['route-removed'] };
		assert.deepStrictEqual(nextEpoch(9, undefined, previous, NOW, ['current']).requiredPeers, [
			'route-removed',
			'current',
		]);
		assert.deepStrictEqual(nextEpoch(9, undefined, { ...previous, finished: true }, NOW, ['current']).requiredPeers, [
			'current',
		]);
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
	it('is unprovable when a peer purged past everything this node still held', () => {
		const purged = { b: clean, c: { epoch: epoch.before, purgedThrough: NOW + 1 } };
		assert.strictEqual(lineageFromReports(epoch, [], 'self', (p) => purged[p], member).state, 'unprovable');
	});
	it('is unprovable when a peer purged into the window below the last surviving key', () => {
		// the log appends in commit order: a write keyed 175 can append after the one keyed 200 and be lost
		const window = { after: 140, lastKey: 200, before: 300, requiredPeers: ['b'] };
		const report = { epoch: 300, purgedThrough: 180 };
		assert.strictEqual(lineageFromReports(window, [], 'self', () => report, member).state, 'unprovable');
	});
	it("accepts a purge that stopped at or below the window's start", () => {
		const purged = { b: clean, c: { epoch: epoch.before, purgedThrough: epoch.after } };
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
	const range = { name: 'receiver', startTime: NOW - 60_000, endTime: NOW, ownOriginRecovery: true };
	const subscriptions = [{ name: 'sender', startTime: NOW - 5_000 }, range];
	it("finds the receiver's own bounded range from a receiver with the capability", () => {
		assert.strictEqual(findOwnOriginRecoveryRange(subscriptions, 'receiver', true), range);
	});
	it("leaves an older receiver's request, a failover self catch-up, another node's range, and an unbounded one alone", () => {
		assert.strictEqual(findOwnOriginRecoveryRange(subscriptions, 'receiver', false), undefined);
		const failover = { name: 'receiver', startTime: NOW - 1_000, endTime: NOW };
		assert.strictEqual(findOwnOriginRecoveryRange([{ name: 'sender' }, failover, range], 'receiver', true), range);
		assert.strictEqual(findOwnOriginRecoveryRange(subscriptions, 'other', true), undefined);
		assert.strictEqual(
			findOwnOriginRecoveryRange(
				[{ name: 'receiver', startTime: NOW - 60_000, ownOriginRecovery: true }],
				'receiver',
				true
			),
			undefined
		);
		assert.strictEqual(
			findOwnOriginRecoveryRange(
				[{ name: 'receiver', startTime: NOW, endTime: NOW, ownOriginRecovery: true }],
				'receiver',
				true
			),
			undefined
		);
	});
	it('accepts a range starting at 1, which an empty log asks for', () => {
		const fromOne = { name: 'receiver', startTime: 1, endTime: NOW, ownOriginRecovery: true };
		assert.strictEqual(findOwnOriginRecoveryRange([fromOne], 'receiver', true), fromOne);
	});
});

describe('returnedByOwnOriginRecovery', () => {
	it("leaves out a sharded table's residency records and keeps every other record", () => {
		const sharded = { residency: { slots: 2 } };
		for (const type of ['put', 'patch', 'delete', 'invalidate', 'relocate'])
			assert.strictEqual(returnedByOwnOriginRecovery(sharded, type), false, type);
		assert.strictEqual(returnedByOwnOriginRecovery(sharded, 'lockBarrier'), true);
		assert.strictEqual(returnedByOwnOriginRecovery({}, 'put'), true, 'an ordinary table in the same database');
		assert.strictEqual(returnedByOwnOriginRecovery(undefined, 'put'), true);
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

describe('markOwnOriginRecoveryFailed', () => {
	it('makes own lineage unprovable for that database only, and records it in the env workers inherit', () => {
		const saved = process.env.HARPER_OWN_ORIGIN_RECOVERY_FAILED;
		try {
			markOwnOriginRecoveryFailed('own-origin-failed-db');
			assert.strictEqual(ownLineage('own-origin-failed-db', null, [], 'self').state, 'unprovable');
			assert.match(
				process.env.HARPER_OWN_ORIGIN_RECOVERY_FAILED,
				new RegExp(`^${process.pid}\n.*own-origin-failed-db`, 's')
			);
			assert.strictEqual(ownLineage('own-origin-other-db', null, [], 'self').state, 'intact');
		} finally {
			if (saved === undefined) delete process.env.HARPER_OWN_ORIGIN_RECOVERY_FAILED;
			else process.env.HARPER_OWN_ORIGIN_RECOVERY_FAILED = saved;
		}
	});
});

describe('continuesEpoch', () => {
	const previous = { after: 1, lastKey: 50, before: NOW, requiredPeers: [], bootId: 'boot-a' };
	const sameBoot = { bootId: 'boot-a', syncFailure: false };
	it('continues on the boot the previous epoch opened on, with no sync failure since', () => {
		assert.strictEqual(continuesEpoch(previous, sameBoot, 50), true);
		assert.strictEqual(continuesEpoch({ ...previous, finished: false }, sameBoot, 80), true);
	});
	it('opens a new epoch after a changed or unknown boot, a sync failure, or with no boot recorded', () => {
		assert.strictEqual(continuesEpoch(previous, { bootId: 'boot-b', syncFailure: false }, 50), false);
		assert.strictEqual(continuesEpoch(previous, { bootId: undefined, syncFailure: false }, 50), false);
		assert.strictEqual(continuesEpoch(previous, { bootId: 'boot-a', syncFailure: true }, 50), false);
		assert.strictEqual(continuesEpoch({ ...previous, bootId: undefined }, sameBoot, 50), false);
		assert.strictEqual(continuesEpoch(undefined, sameBoot, 50), false);
	});
	it('opens a new epoch when the log holds less than it did when the previous epoch opened', () => {
		assert.strictEqual(continuesEpoch(previous, sameBoot, 49), false);
	});
});

describe('openOwnOriginRecoveryEpoch', () => {
	const EPOCH = Symbol.for('ownOriginRecovery');
	function stores(previous, { reports = [], logReadFails = false } = {}) {
		const rows = new Map();
		if (previous) rows.set(EPOCH, previous);
		let syncs = 0;
		const dbisDB = {
			rows,
			getSync: (key) => rows.get(key),
			putSync: (key, value) => rows.set(key, value),
			getRange: ({ start }) =>
				Array.isArray(start) && start[0] === Symbol.for('ownOriginPurged')
					? reports.map((value) => ({ key: [start[0], value.peer], value }))
					: [],
		};
		const auditStore = {
			reusableIterable: true,
			getRange: () => {
				if (logReadFails) throw new Error('EIO');
				return [];
			},
			getBinary: () => undefined,
			rootStore: {
				getMonotonicTimestamp: () => NOW + 1000,
				syncWal: async () => {
					syncs++;
				},
			},
		};
		return { dbisDB, auditStore, syncs: () => syncs };
	}
	// the fake log is empty, so an epoch it can continue recorded nothing held
	const settled = { after: 5, lastKey: 0, before: NOW, requiredPeers: ['peer'], bootId: 'boot-a', finished: true };

	it('leaves the previous epoch in force on the same boot: nothing written and nothing synced', () => {
		const { dbisDB, auditStore, syncs } = stores(settled);
		const result = openOwnOriginRecoveryEpoch(
			'continued-db',
			auditStore,
			dbisDB,
			{ bootId: 'boot-a', syncFailure: false },
			() => []
		);
		assert.strictEqual(result, undefined);
		assert.strictEqual(syncs(), 0);
		assert.deepStrictEqual(dbisDB.rows.get(EPOCH), settled);
	});

	it('keeps an unfinished epoch on the same boot, so peers that never reported are still asked for its window', () => {
		const unfinished = { ...settled, finished: undefined };
		const { dbisDB, auditStore } = stores(unfinished);
		openOwnOriginRecoveryEpoch('unfinished-db', auditStore, dbisDB, { bootId: 'boot-a', syncFailure: false }, () => []);
		assert.deepStrictEqual(recoveryRangeFor(dbisDB, 'peer'), { startTime: 5, endTime: NOW });
	});

	it('does not continue an epoch a peer reported purging past, so a new epoch judges purges against the log now', () => {
		const { dbisDB, auditStore, syncs } = stores(settled, {
			reports: [{ peer: 'peer', epoch: NOW, purgedThrough: 6 }],
		});
		const result = openOwnOriginRecoveryEpoch(
			'tainted-db',
			auditStore,
			dbisDB,
			{ bootId: 'boot-a', syncFailure: false },
			() => []
		);
		assert.ok(result);
		assert.strictEqual(dbisDB.rows.get(EPOCH).before, NOW + 1000);
		return result.then(() => assert.strictEqual(syncs(), 1));
	});

	it('opens the widest epoch when the own log cannot be read, even on the same boot', async () => {
		const { dbisDB, auditStore } = stores(settled, { logReadFails: true });
		await openOwnOriginRecoveryEpoch(
			'unreadable-db',
			auditStore,
			dbisDB,
			{ bootId: 'boot-a', syncFailure: false },
			() => []
		);
		const epoch = dbisDB.rows.get(EPOCH);
		assert.strictEqual(epoch.before, NOW + 1000);
		assert.strictEqual(epoch.after, 1);
	});

	it('requires the members it sends the database to, not only peers that sent back', async () => {
		const { dbisDB, auditStore } = stores(undefined);
		await openOwnOriginRecoveryEpoch(
			'recipients-db',
			auditStore,
			dbisDB,
			{ bootId: 'boot-a', syncFailure: false },
			() => ['receives-only']
		);
		assert.deepStrictEqual(dbisDB.rows.get(EPOCH).requiredPeers, ['receives-only']);
	});

	for (const [label, continuity, previous] of [
		['a changed boot', { bootId: 'boot-b', syncFailure: false }, settled],
		['an unknown boot', { bootId: undefined, syncFailure: false }, settled],
		['a recorded sync failure', { bootId: 'boot-a', syncFailure: true }, settled],
		[
			'a previous epoch with no boot recorded',
			{ bootId: 'boot-a', syncFailure: false },
			{ ...settled, bootId: undefined },
		],
		['no previous epoch', { bootId: 'boot-a', syncFailure: false }, undefined],
		[
			'a log holding less than when the epoch opened',
			{ bootId: 'boot-a', syncFailure: false },
			{ ...settled, lastKey: 10 },
		],
	]) {
		it(`opens a new epoch, recording the boot, after ${label}`, async () => {
			const { dbisDB, auditStore, syncs } = stores(previous);
			const result = openOwnOriginRecoveryEpoch('opened-db', auditStore, dbisDB, continuity, () => ['recipient']);
			await result;
			assert.strictEqual(syncs(), 1);
			const epoch = dbisDB.rows.get(EPOCH);
			assert.strictEqual(epoch.before, NOW + 1000);
			assert.strictEqual(epoch.bootId, continuity.bootId);
			assert.strictEqual(epoch.finished, undefined);
			assert.deepStrictEqual(recoveryRangeFor(dbisDB, 'peer'), { startTime: epoch.after, endTime: NOW + 1000 });
		});
	}
});

describe('ownLineage caching', () => {
	const EPOCH = Symbol.for('ownOriginRecovery');
	const REPORT = Symbol.for('ownOriginRecovered');
	const epoch = { after: NOW - 60_000, lastKey: NOW, before: NOW + 10_000, requiredPeers: ['b', 'c'] };
	before(() => setupTestDBPath());
	async function epochStore(database) {
		const Table = table({ database, table: 'Rows', attributes: [{ name: 'id', isPrimaryKey: true }] });
		const dbisDB = Table.dbisDB;
		dbisDB.putSync(EPOCH, epoch);
		return dbisDB;
	}
	const report = (dbisDB, peer, value = { epoch: epoch.before }) => dbisDB.put([REPORT, peer], value);

	it('keeps a proof for the home list it was made for, and evaluates a new home list afresh', async () => {
		const dbisDB = await epochStore('own-lineage-proven');
		await report(dbisDB, 'b');
		await report(dbisDB, 'c');
		const homes = ['self', 'b'];
		assert.strictEqual(ownLineage('own-lineage-proven', NOW, homes, 'self', undefined, () => true).state, 'intact');
		assert.strictEqual(ownLineage('own-lineage-proven', null, homes, 'self', undefined, () => true).state, 'intact');
		assert.strictEqual(
			ownLineage('own-lineage-proven', NOW, ['self', 'b', 'd'], 'self', undefined, () => true).state,
			'pending',
			'a home added since needs its own report'
		);
	});
	it('keeps a proof that skipped a removed member only while that member stays removed', async () => {
		const dbisDB = await epochStore('own-lineage-skipped');
		await report(dbisDB, 'b');
		const checked = [];
		let cRemoved = true;
		const memberCheck = (peer) => {
			checked.push(peer);
			return peer !== 'c' || !cRemoved;
		};
		const homes = ['self'];
		assert.strictEqual(ownLineage('own-lineage-skipped', NOW, homes, 'self', undefined, memberCheck).state, 'intact');
		checked.length = 0;
		for (let i = 0; i < 10; i++) ownLineage('own-lineage-skipped', null, homes, 'self', undefined, memberCheck);
		assert.deepStrictEqual(new Set(checked), new Set(['c']), 'a repeat check probes only the skipped member');
		assert.strictEqual(checked.length, 10);
		cRemoved = false;
		assert.strictEqual(
			ownLineage('own-lineage-skipped', null, homes, 'self', undefined, memberCheck).state,
			'pending',
			'a re-added member must report before own lineage is proven again'
		);
	});
	it('serves a pending result until the recheck interval passes, then sees the report that landed', async () => {
		const dbisDB = await epochStore('own-lineage-pending');
		await report(dbisDB, 'b');
		const homes = ['self'];
		assert.strictEqual(ownLineage('own-lineage-pending', NOW, homes, 'self', undefined, () => true).state, 'pending');
		await report(dbisDB, 'c');
		assert.strictEqual(ownLineage('own-lineage-pending', NOW, homes, 'self', undefined, () => true).state, 'pending');
		await delay(UNPROVEN_RECHECK_MS + 10);
		assert.strictEqual(ownLineage('own-lineage-pending', NOW, homes, 'self', undefined, () => true).state, 'intact');
	});
	it('a clean pass proves a peer even when a pass that met a purge is also recorded', async () => {
		const dbisDB = await epochStore('own-lineage-purged-then-clean');
		await report(dbisDB, 'c');
		await dbisDB.put([Symbol.for('ownOriginPurged'), 'b'], { epoch: epoch.before, purgedThrough: epoch.after + 1 });
		const homes = ['self'];
		assert.strictEqual(
			ownLineage('own-lineage-purged-then-clean', NOW, homes, 'self', undefined, () => true).state,
			'unprovable'
		);
		await report(dbisDB, 'b');
		await delay(UNPROVEN_RECHECK_MS + 10);
		assert.strictEqual(
			ownLineage('own-lineage-purged-then-clean', NOW, homes, 'self', undefined, () => true).state,
			'intact'
		);
	});
	it('admits a position minted since the epoch opened without any report', async () => {
		await epochStore('own-lineage-new-position');
		assert.strictEqual(
			ownLineage('own-lineage-new-position', epoch.before, ['self'], 'self', undefined, () => true).state,
			'intact'
		);
	});
});
