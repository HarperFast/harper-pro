// harper-pro#1454: with no floor, the sender's own log resumes past the receiver's anchor in append order.
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ownLogAppendAnchor,
	ownLogPastAnchorRange,
	OWN_LOG_SLICE_ENTRIES,
	endsOwnLogSlice,
	ownLogReadFailed,
	ownLogResumeAnchor,
	rangeBoundaryFailure,
} from '#src/replication/replicationConnection';
import { RocksTransactionLogStore } from '#src/core/resources/RocksTransactionLogStore';
import { releaseLocalKey, reserveLocalKey } from '#src/core/resources/originClosedFloor';

// Required, not imported: the ESM entry would evaluate a second copy of the package beside the one the
// data layer already loaded through CJS.
const { RocksDatabase } = createRequire(import.meta.url)('@harperfast/rocksdb-js');

const T = 1_790_000_000_000;

describe('ownLogResumeAnchor', () => {
	it('names the highest key applied from the origin when no valid floor is held', () => {
		assert.strictEqual(ownLogResumeAnchor({ id: 1, originLogKey: T }), T);
		for (const closedFloor of [undefined, null, 0, NaN, '1'])
			assert.strictEqual(ownLogResumeAnchor({ id: 1, originLogKey: T, closedFloor }), T, String(closedFloor));
	});

	it('names nothing when a valid floor is the proven start, or the key is missing or malformed', () => {
		assert.strictEqual(ownLogResumeAnchor({ id: 1, originLogKey: T, closedFloor: T - 1000 }), undefined);
		assert.strictEqual(ownLogResumeAnchor(undefined), undefined);
		for (const originLogKey of [undefined, 0, -1, NaN, Infinity, 8.64e15 + 1, String(T)])
			assert.strictEqual(ownLogResumeAnchor({ id: 1, originLogKey }), undefined, String(originLogKey));
	});
});

describe('ownLogAppendAnchor', () => {
	it('honors a valid anchor on a store that resumes past entries', () => {
		assert.strictEqual(ownLogAppendAnchor({ name: 'self', startTime: T + 5, resumeAfter: T }, true), T);
	});

	it('ignores the anchor on a store that cannot resume past entries, on a copy, or when it is malformed', () => {
		assert.strictEqual(ownLogAppendAnchor({ startTime: T + 5, resumeAfter: T }, false), undefined);
		for (const startTime of [0, 1, undefined])
			assert.strictEqual(ownLogAppendAnchor({ startTime, resumeAfter: T }, true), undefined, String(startTime));
		for (const resumeAfter of [undefined, 0, NaN, String(T)])
			assert.strictEqual(ownLogAppendAnchor({ startTime: T, resumeAfter }, true), undefined, String(resumeAfter));
		assert.strictEqual(ownLogAppendAnchor(undefined, true), undefined);
	});
});

describe('endsOwnLogSlice', () => {
	it('ends a slice past its budget, and only at the end of a transaction', () => {
		assert.strictEqual(endsOwnLogSlice(OWN_LOG_SLICE_ENTRIES - 1, { endTxn: true }), false);
		assert.strictEqual(endsOwnLogSlice(OWN_LOG_SLICE_ENTRIES, { endTxn: false }), false);
		assert.strictEqual(endsOwnLogSlice(OWN_LOG_SLICE_ENTRIES, {}), false);
		assert.strictEqual(endsOwnLogSlice(OWN_LOG_SLICE_ENTRIES, { endTxn: true }), true);
	});
});

describe('ownLogReadFailed', () => {
	it('reports a missed anchor, a failed log or a corrupt-frame stop, and nothing on a clean range', () => {
		assert.strictEqual(ownLogReadFailed({}), false);
		assert.strictEqual(ownLogReadFailed(undefined), false);
		assert.strictEqual(
			ownLogReadFailed({ exactStartFailures: new Map(), failedLogs: new Set(), corruptFrameStop: { breaks: 0 } }),
			false
		);
		assert.strictEqual(ownLogReadFailed({ exactStartFailures: new Map([['local', 'missing']]) }), true);
		assert.strictEqual(ownLogReadFailed({ failedLogs: new Set(['local']) }), true);
		assert.strictEqual(ownLogReadFailed({ corruptFrameStop: { breaks: 1 } }), true);
	});
});

describe('ownLogPastAnchorRange on a RocksDB transaction log', function () {
	this.timeout(30000);
	let root;
	let db;
	let store;

	async function append(key) {
		let handle;
		try {
			await db.transaction((transaction) => {
				handle = transaction;
				reserveLocalKey(db, transaction);
				transaction.setTimestamp(key);
				store.put(
					0,
					{
						type: 'put',
						tableId: 7,
						recordId: `k${key - T}`,
						version: key,
						nodeId: 0,
						user: 'admin',
						encodedRecord: Buffer.from([0x81, 0xa1, 0x61, 0x01]),
						structureVersion: 0,
					},
					{ transaction }
				);
			});
		} finally {
			releaseLocalKey(handle);
		}
	}

	before(async () => {
		root = mkdtempSync(join(tmpdir(), 'own-log-resume-'));
		db = new RocksDatabase(join(root, 'db'));
		db.open();
		store = new RocksTransactionLogStore(db);
		// appended in this order: the last one reserved the lowest key and committed after the others
		for (const key of [T, T + 20, T + 10]) await append(key);
	});

	after(() => {
		db?.close();
		if (root) rmSync(root, { recursive: true, force: true });
	});

	const keysOf = (range) => Array.from(range, (record) => record.txnLogKey);

	it('a range from the received key maximum skips the entry appended after it with a lower key', () => {
		assert.deepStrictEqual(keysOf(store.getRange({ log: 'local', start: T + 20, exclusiveStart: true })), []);
	});

	it('the range past that entry delivers it', () => {
		assert.strictEqual(rangeBoundaryFailure(store, ownLogPastAnchorRange(T + 20)), false);
		assert.deepStrictEqual(keysOf(store.getRange(ownLogPastAnchorRange(T + 20))), [T + 10]);
		assert.deepStrictEqual(keysOf(store.getRange(ownLogPastAnchorRange(T))), [T + 20, T + 10]);
	});

	it('past the last entry, the range is empty and then tails what is appended next', async () => {
		assert.strictEqual(rangeBoundaryFailure(store, ownLogPastAnchorRange(T + 10)), false);
		const range = store.getRange(ownLogPastAnchorRange(T + 10));
		assert.deepStrictEqual(keysOf(range), []);
		await append(T + 5);
		assert.deepStrictEqual(keysOf(range), [T + 5]);
	});

	it('reports an anchor that names no entry, so the sender reads the log from its oldest entry instead', () => {
		assert.ok(rangeBoundaryFailure(store, ownLogPastAnchorRange(T + 15)));
		assert.deepStrictEqual(keysOf(store.getRange({ log: 'local', start: 0, snapshot: false })), [
			T,
			T + 20,
			T + 10,
			T + 5,
		]);
	});
});
