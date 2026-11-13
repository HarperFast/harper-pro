import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	advanceDurableFloor,
	openOwnOriginRecoveryEpoch,
	recoveryRangeFor,
	recoveryStart,
	sampleDurableFloors,
	vouchesForEarlierLog,
} from '#src/replication/ownOriginRecovery';
import { cursorBelowFloor, ORIGIN_CURSOR_OVERLAP_MS } from '#src/replication/replicationConnection';
import { table } from '#src/core/resources/databases';
import { persistOriginClosedFloor, readOriginClosedFloor } from '#src/core/resources/auditStore';
import { certifyOriginFloor } from '#src/core/resources/originClosedFloor';
import { setMainIsWorker } from '#js/core/server/threads/manageThreads';

const require = createRequire(import.meta.url);
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { setupTestDBPath } = require('../testUtils.js');

const NOW = 1_800_000_000_000;
const DURABLE_FLOOR = Symbol.for('ownOriginDurableFloor');
const EPOCH = Symbol.for('ownOriginRecovery');
const LOG_VOUCH = Symbol.for('ownOriginLogVouch');
const position = (sequence, offset) => ({ sequence, offset });
const freshState = (bound = 0) => ({ samples: [], bound, persisted: bound });

describe('recoveryStart with a durable floor', () => {
	it('starts just below the floor, so a write keyed at the floor is still asked for', () => {
		const floor = NOW - 200_000;
		const after = recoveryStart(NOW, undefined, undefined, floor);
		assert.strictEqual(after, cursorBelowFloor(floor));
		assert.ok(after < floor);
	});
	it('never starts above the overlap, so a floor can widen the window but not narrow it', () => {
		assert.strictEqual(recoveryStart(NOW, undefined, undefined, NOW - 5_000), NOW - ORIGIN_CURSOR_OVERLAP_MS);
	});
	it('falls back to the overlap without a floor, and starts at 1 for an empty log whatever the floor', () => {
		assert.strictEqual(recoveryStart(NOW, undefined, undefined, undefined), NOW - ORIGIN_CURSOR_OVERLAP_MS);
		assert.strictEqual(recoveryStart(NOW, undefined, undefined, 0), NOW - ORIGIN_CURSOR_OVERLAP_MS);
		assert.strictEqual(recoveryStart(undefined, undefined, undefined, NOW - 200_000), 1);
	});
	it("keeps an unfinished earlier epoch's lower start", () => {
		const earlier = { after: NOW - 3_600_000, lastKey: NOW, before: NOW - 1_000, requiredPeers: [] };
		assert.strictEqual(recoveryStart(NOW, undefined, earlier, NOW - 200_000), earlier.after);
	});
});

describe('openOwnOriginRecoveryEpoch after a lost tail', () => {
	// The log kept keys up to NOW; the write keyed NOW - 120 s (reserved 120 s before it was appended, after
	// the write keyed NOW) was in the lost tail. A floor sampled and flushed before the crash is NOW - 200 s.
	const LOST_KEY = NOW - 120_000;
	function stores(durableFloor) {
		const rows = new Map();
		if (durableFloor !== undefined) rows.set(DURABLE_FLOOR, durableFloor);
		const surviving = [NOW];
		const dbisDB = {
			rows,
			getSync: (key) => rows.get(key),
			putSync: (key, value) => rows.set(key, value),
			getRange: () => [],
		};
		const auditStore = {
			reusableIterable: true,
			getRange: ({ start }) => surviving.filter((key) => key >= start).map((key) => ({ txnLogKey: key })),
			getBinary: () => undefined,
			rootStore: { getMonotonicTimestamp: () => NOW + 1000, syncWal: async () => {} },
		};
		return { dbisDB, auditStore };
	}

	it('asks peers for a lost write reserved more than the overlap before its append', async () => {
		const { dbisDB, auditStore } = stores(NOW - 200_000);
		await openOwnOriginRecoveryEpoch(
			'lost-tail-db',
			auditStore,
			dbisDB,
			{ bootId: 'boot-b', syncFailure: false },
			() => ['peer']
		);
		const range = recoveryRangeFor(dbisDB, 'peer');
		assert.ok(range.startTime < LOST_KEY, `the window starts at ${range.startTime}, above the lost key ${LOST_KEY}`);
		assert.strictEqual(range.endTime, NOW + 1000);
	});

	it('asks for a lost write keyed exactly at the floor', async () => {
		const { dbisDB, auditStore } = stores(LOST_KEY);
		await openOwnOriginRecoveryEpoch(
			'floor-key-db',
			auditStore,
			dbisDB,
			{ bootId: 'boot-b', syncFailure: false },
			() => ['peer']
		);
		assert.ok(recoveryRangeFor(dbisDB, 'peer').startTime < LOST_KEY);
	});

	it('keeps the overlap when no durable floor was recorded', async () => {
		const { dbisDB, auditStore } = stores(undefined);
		await openOwnOriginRecoveryEpoch(
			'no-floor-db',
			auditStore,
			dbisDB,
			{ bootId: 'boot-b', syncFailure: false },
			() => ['peer']
		);
		assert.strictEqual(dbisDB.rows.get(EPOCH).after, NOW - ORIGIN_CURSOR_OVERLAP_MS);
	});
});

describe('advanceDurableFloor', () => {
	it('advances only once the flushed position reaches the position sampled with the floor', () => {
		const state = freshState();
		assert.strictEqual(
			advanceDurableFloor(state, 100, { nextLogPosition: position(1, 500), lastFlushedPosition: position(1, 200) }),
			undefined
		);
		assert.strictEqual(
			advanceDurableFloor(state, 110, { nextLogPosition: position(1, 700), lastFlushedPosition: position(1, 499) }),
			undefined,
			'a flush short of the sampled position proves nothing'
		);
		assert.strictEqual(
			advanceDurableFloor(state, 120, { nextLogPosition: position(1, 900), lastFlushedPosition: position(1, 700) }),
			110,
			'the largest floor whose position is covered'
		);
		assert.strictEqual(state.bound, 110);
		assert.deepStrictEqual(state.samples, [{ floor: 120, position: position(1, 900) }]);
	});
	it('compares positions across log segments', () => {
		const state = freshState();
		advanceDurableFloor(state, 100, { nextLogPosition: position(1, 90_000), lastFlushedPosition: position(1, 0) });
		assert.strictEqual(
			advanceDurableFloor(state, 101, { nextLogPosition: position(2, 50), lastFlushedPosition: position(2, 10) }),
			100
		);
	});
	it('never lowers the bound, and ignores floors at or below it or invalid ones', () => {
		const state = freshState(500);
		const stats = { nextLogPosition: position(1, 10), lastFlushedPosition: position(1, 10) };
		assert.strictEqual(advanceDurableFloor(state, 400, stats), undefined);
		assert.strictEqual(advanceDurableFloor(state, NaN, stats), undefined);
		assert.strictEqual(advanceDurableFloor(state, 0, stats), undefined);
		assert.strictEqual(state.bound, 500);
		assert.strictEqual(advanceDurableFloor(state, 600, stats), 600);
	});
	it('ignores unreadable positions', () => {
		const state = freshState();
		assert.strictEqual(advanceDurableFloor(state, 100, undefined), undefined);
		assert.strictEqual(advanceDurableFloor(state, 100, { nextLogPosition: position(1, 5) }), undefined);
		assert.deepStrictEqual(state.samples, []);
	});
	it('keeps a bounded sample list that still holds the newest sample', () => {
		const state = freshState();
		for (let index = 1; index <= 200; index++)
			advanceDurableFloor(state, index, {
				nextLogPosition: position(1, index * 10),
				lastFlushedPosition: position(1, 0),
			});
		assert.ok(state.samples.length <= 64);
		assert.strictEqual(state.samples.at(-1).floor, 200);
		assert.strictEqual(
			advanceDurableFloor(state, 201, { nextLogPosition: position(1, 2010), lastFlushedPosition: position(1, 2000) }),
			200
		);
	});
});

describe('vouchesForEarlierLog', () => {
	const sameBoot = { bootId: 'boot-a', syncFailure: false };
	const vouchedOnA = { bootId: 'boot-a', vouched: true };
	const oneSegment = { nextLogPosition: position(3, 900), lastFlushedPosition: position(3, 100) };
	const twoSegments = { nextLogPosition: position(4, 900), lastFlushedPosition: position(3, 100) };
	it('vouches when the flushed position is in the segment the log appends to', () => {
		assert.strictEqual(vouchesForEarlierLog(vouchedOnA, sameBoot, oneSegment), true);
		assert.strictEqual(vouchesForEarlierLog(undefined, sameBoot, oneSegment), true);
	});
	it('does not vouch for an earlier segment an earlier process on this boot may have left unsynced', () => {
		assert.strictEqual(vouchesForEarlierLog(vouchedOnA, sameBoot, twoSegments), false);
		assert.strictEqual(vouchesForEarlierLog(undefined, sameBoot, twoSegments), false);
		assert.strictEqual(vouchesForEarlierLog(vouchedOnA, { bootId: undefined, syncFailure: false }, twoSegments), false);
	});
	it('stays unvouched on a boot where a start could not vouch, even once the flushed position catches up', () => {
		assert.strictEqual(vouchesForEarlierLog({ bootId: 'boot-a', vouched: false }, sameBoot, oneSegment), false);
		assert.strictEqual(
			vouchesForEarlierLog({ vouched: false }, { bootId: undefined, syncFailure: false }, oneSegment),
			false
		);
	});
	it('vouches after a reboot, since whatever survived it is on disk', () => {
		const rebooted = { bootId: 'boot-b', syncFailure: false };
		assert.strictEqual(vouchesForEarlierLog(vouchedOnA, rebooted, twoSegments), true);
		assert.strictEqual(vouchesForEarlierLog({ bootId: 'boot-a', vouched: false }, rebooted, twoSegments), true);
	});
	it('never vouches after a recorded sync failure, or without positions', () => {
		assert.strictEqual(vouchesForEarlierLog(vouchedOnA, { bootId: 'boot-b', syncFailure: true }, oneSegment), false);
		assert.strictEqual(vouchesForEarlierLog(vouchedOnA, sameBoot, undefined), false);
	});
});

describe('openOwnOriginRecoveryEpoch records its log vouch', () => {
	function stores(rows, stats) {
		const dbisDB = {
			rows,
			getSync: (key) => rows.get(key),
			putSync: (key, value) => rows.set(key, value),
			getRange: () => [],
		};
		const auditStore = {
			reusableIterable: true,
			getRange: () => [],
			getBinary: () => undefined,
			log: { getStats: () => stats },
			rootStore: { getMonotonicTimestamp: () => NOW + 1000, syncWal: async () => {} },
		};
		return { dbisDB, auditStore };
	}
	it('for the next start on this boot, including a verdict of no', async () => {
		const rows = new Map();
		const { dbisDB, auditStore } = stores(rows, {
			nextLogPosition: position(4, 10),
			lastFlushedPosition: position(3, 10),
		});
		await openOwnOriginRecoveryEpoch(
			'vouch-row-db',
			auditStore,
			dbisDB,
			{ bootId: 'boot-a', syncFailure: false },
			() => []
		);
		assert.deepStrictEqual(rows.get(LOG_VOUCH), { bootId: 'boot-a', vouched: false });
	});
});

describe('a durable floor on a real rocksdb-js log', () => {
	let directory;
	let db;
	before(() => {
		directory = mkdtempSync(join(tmpdir(), 'durable-floor-'));
		db = RocksDatabase.open(directory, { disableWAL: true });
	});
	after(() => {
		db?.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it('advances only when a memtable flush covers the sampled position', async () => {
		const log = db.useLog('local');
		const append = (key) =>
			db.transaction(async (txn) => {
				txn.putSync(key, 'value');
				log.addEntry(Buffer.from(key), txn.id);
			});
		const state = freshState();
		await append('a');
		assert.strictEqual(advanceDurableFloor(state, NOW + 1, log.getStats()), undefined);
		await append('b');
		assert.strictEqual(advanceDurableFloor(state, NOW + 2, log.getStats()), undefined);
		await db.flush();
		await append('c');
		assert.strictEqual(advanceDurableFloor(state, NOW + 3, log.getStats()), NOW + 2);
		assert.strictEqual(
			advanceDurableFloor(state, NOW + 4, log.getStats()),
			undefined,
			'nothing appended since NOW + 3 was sampled, and nothing flushed'
		);
		await db.flush();
		assert.strictEqual(
			advanceDurableFloor(state, NOW + 5, log.getStats()),
			NOW + 3,
			'a floor over an unchanged log is not sampled'
		);
		await append('d');
		assert.strictEqual(advanceDurableFloor(state, NOW + 6, log.getStats()), undefined);
		await db.flush();
		assert.strictEqual(advanceDurableFloor(state, NOW + 7, log.getStats()), NOW + 6);
	});
});

describe('sampleDurableFloors on a database', () => {
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});
	after(() => setMainIsWorker(false));

	it('records the certified floor in dbis once a flush covers it', async function () {
		this.timeout(20_000);
		const Durable = table({
			table: 'OwnOriginDurableFloor',
			database: 'own_origin_durable_floor',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		const { auditStore, dbisDB } = Durable;
		const rootStore = auditStore.rootStore;
		await rootStore.flush();
		await openOwnOriginRecoveryEpoch(
			'own_origin_durable_floor',
			auditStore,
			dbisDB,
			{ bootId: undefined, syncFailure: false },
			() => []
		);
		await Durable.put({ id: 1, name: 'before' });
		let floor;
		for (let attempt = 0; attempt < 100 && !(floor > 0); attempt++) floor = certifyOriginFloor(rootStore);
		persistOriginClosedFloor(auditStore, floor);
		assert.strictEqual(readOriginClosedFloor(auditStore), floor);
		await Durable.put({ id: 2, name: 'unflushed' });
		sampleDurableFloors();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.strictEqual(dbisDB.getSync(DURABLE_FLOOR), undefined, 'no flush covers the sample yet');
		await rootStore.flush();
		sampleDurableFloors();
		const deadline = Date.now() + 5000;
		while (!(dbisDB.getSync(DURABLE_FLOOR) >= floor) && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(dbisDB.getSync(DURABLE_FLOOR) >= floor);

		const recorded = dbisDB.getSync(DURABLE_FLOOR);
		await Durable.put({ id: 3, name: 'after' });
		let later;
		for (let attempt = 0; attempt < 100 && !(later > recorded); attempt++) {
			later = certifyOriginFloor(rootStore);
			if (!(later > recorded)) await new Promise((resolve) => setTimeout(resolve, 5));
		}
		persistOriginClosedFloor(auditStore, later);
		await Durable.put({ id: 4, name: 'later' });
		sampleDurableFloors();
		await rootStore.flush();
		const put = dbisDB.put;
		dbisDB.put = () => {
			throw new Error('ENOSPC');
		};
		try {
			sampleDurableFloors();
			await new Promise((resolve) => setTimeout(resolve, 20));
		} finally {
			dbisDB.put = put;
		}
		assert.strictEqual(dbisDB.getSync(DURABLE_FLOOR), recorded, 'the failed put recorded nothing');
		sampleDurableFloors();
		const retryDeadline = Date.now() + 5000;
		while (!(dbisDB.getSync(DURABLE_FLOOR) >= later) && Date.now() < retryDeadline)
			await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(dbisDB.getSync(DURABLE_FLOOR) >= later, 'a synchronous put failure is retried on the next tick');
	});
});
