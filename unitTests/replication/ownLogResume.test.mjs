// harper-pro#1454: with no floor, the sender's own log resumes past the receiver's anchor in append order.
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ownLogAppendAnchor,
	ownLogPastAnchorRange,
	ownLogResumeAnchor,
	ownLogSliceThenOthers,
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

describe('ownLogSliceThenOthers', () => {
	// a live tail: refilling it after a pass hands the next pass only the new entries, and closing it is an error
	const tail = (entries) => {
		let index = 0;
		const iterator = {
			next: () => (index < entries.length ? { value: entries[index++], done: false } : { done: true }),
			return: () => assert.fail('the own-log range must not be closed between passes'),
		};
		return { entries, [Symbol.iterator]: () => iterator };
	};
	const entry = (key, endTxn = true) => ({ key, endTxn });
	const keys = (range) => Array.from(range, ({ key }) => key);

	it('reads all of a short own log and then the other logs, reporting the own log drained', () => {
		const slice = { drained: false };
		assert.deepStrictEqual(keys(ownLogSliceThenOthers(tail([entry(1), entry(2)]), [entry('a')], 5, slice)), [
			1,
			2,
			'a',
		]);
		assert.strictEqual(slice.drained, true);
	});

	it('serves the other logs after the budget while the own log keeps growing, and resumes it next pass', () => {
		const own = tail([entry(1), entry(2), entry(3), entry(4)]);
		const slice = { drained: true };
		assert.deepStrictEqual(keys(ownLogSliceThenOthers(own, [entry('a')], 1, slice)), [1, 2, 'a']);
		assert.strictEqual(slice.drained, false);
		own.entries.push(entry(5));
		assert.deepStrictEqual(keys(ownLogSliceThenOthers(own, [entry('b')], 10, slice)), [3, 4, 5, 'b']);
		assert.strictEqual(slice.drained, true);
	});

	it('cuts only at the end of a transaction, since a frame carries one', () => {
		const own = tail([entry(1, false), entry(1, false), entry(1, true), entry(2)]);
		const slice = { drained: true };
		assert.deepStrictEqual(keys(ownLogSliceThenOthers(own, [entry('a')], 0, slice)), [1, 1, 1, 'a']);
		assert.strictEqual(slice.drained, false);
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
