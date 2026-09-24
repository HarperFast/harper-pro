/**
 * The base-copy resume anchor, and the log properties it rests on (harper-pro#876).
 *
 * A transaction's log key is fixed when it is CREATED; its log batch is appended when it COMMITS. The
 * log is therefore written out of key order, so a timestamp cursor is not a boundary in it, while the
 * last committed entry is.
 *
 * The first suite runs against a real RocksDB transaction log, because both the defect and the fix
 * live in how the range predicate treats a late-appended entry; against a stub they would only
 * re-state the assumption.
 */

import { expect } from 'chai';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
	classifyResumeAnchor,
	findLastCommittedLogKey,
	isCopyResumeOrderCompatible,
} from '#src/replication/replicationConnection';

// Through `require`, not `import`: rocksdb-js decorates the native `TransactionLog` prototype at load,
// and core already loaded its CJS build — a second (ESM) instance redefines that property and throws.
const { RocksDatabase } = createRequire(import.meta.url)('@harperfast/rocksdb-js');

async function withDatabase(run) {
	const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'copy-anchor-'));
	const db = RocksDatabase.open(join(dir, 'db'));
	try {
		await run(db, db.useLog('local'));
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

const payloads = (log, options) => [...log.query(options)].map((entry) => Buffer.from(entry.data).toString());
// The slice of the audit store's getRange that findLastCommittedLogKey reads, over a real log.
const storeOver = (log) => ({
	getRange: (options) => [...log.query(options)].map((entry) => ({ txnLogKey: entry.timestamp })),
});

describe('the base-copy resume boundary, against a real transaction log', () => {
	it('a timestamp anchor drops a transaction created before it and committed after it', async () =>
		withDatabase(async (db, log) => {
			let release;
			const held = new Promise((resolve) => (release = resolve));
			let inFlightKey;
			const inFlight = db.transaction(async (txn) => {
				inFlightKey = txn.getTimestamp();
				log.addEntry(Buffer.from('IN-FLIGHT'), txn.id);
				await held;
			});
			let anchor;
			await db.transaction((txn) => {
				anchor = txn.getTimestamp();
				log.addEntry(Buffer.from('LAST'), txn.id);
			});
			release();
			await inFlight;

			expect(inFlightKey).to.be.below(anchor);
			expect(payloads(log, { start: 0 })).to.deep.equal(['LAST', 'IN-FLIGHT']);
			expect(payloads(log, { start: anchor, exclusiveStart: true })).to.deep.equal([]);
		}));

	it('resuming past the last committed entry yields a transaction that was in flight when it was read', async () =>
		withDatabase(async (db, log) => {
			let release;
			const held = new Promise((resolve) => (release = resolve));
			const inFlight = db.transaction(async (txn) => {
				log.addEntry(Buffer.from('IN-FLIGHT'), txn.id);
				await held;
			});
			let lastKey;
			await db.transaction((txn) => {
				lastKey = txn.getTimestamp();
				log.addEntry(Buffer.from('LAST'), txn.id);
			});

			// Flushed first: the anchor must not depend on anything having been written since a flush.
			await db.flush();
			const anchor = findLastCommittedLogKey(storeOver(log), 'local');
			expect(anchor).to.equal(lastKey);

			release();
			await inFlight;
			await db.transaction((txn) => log.addEntry(Buffer.from('AFTER'), txn.id));

			// Once `exactStart` matches the anchor the predicate stops consulting the key at all, so the
			// older-keyed in-flight transaction is delivered.
			expect(payloads(log, { start: anchor, exactStart: true, exclusiveStart: true })).to.deep.equal([
				'IN-FLIGHT',
				'AFTER',
			]);
		}));

	it('every entry the log yields is already visible to a read', async () =>
		withDatabase(async (db, log) => {
			// An assumption about the storage engine — the committed watermark advances only after the
			// RocksDB commit — so it is pinned rather than described.
			const count = 200;
			let settled = false;
			const writes = Promise.all(
				Array.from({ length: count }, (_, i) => {
					const key = `k${i}`;
					return db.transaction((txn) => {
						log.addEntry(Buffer.from(key), txn.id);
						db.putSync(key, 1);
					});
				})
			).then(() => (settled = true));
			const tail = log.query({ start: 0 });
			const notYetVisible = [];
			let seen = 0;
			while (seen < count) {
				for (const entry of tail) {
					seen++;
					const key = Buffer.from(entry.data).toString();
					if (db.getSync(key) === undefined) notYetVisible.push(key);
				}
				if (settled && seen < count) break;
				await new Promise((resolve) => setImmediate(resolve));
			}
			await writes;
			expect(seen).to.equal(count);
			expect(notYetVisible).to.deep.equal([]);
		}));
});

describe('isCopyResumeOrderCompatible', () => {
	// This gates the copy-table-ORDER skip-loop (#421), unrelated to the resume anchor below:
	// harper-pro#876 leaves COPY_ORDER_VERSION at 1, so a pre-#876 leader's cursor is `(1, 1)` here —
	// accepted, same as any other leader on today's order version. `undefined` is a leader from before
	// #421 existed at all (no `copyOrder` field).
	it('rejects a cursor whose copyOrder is absent or from a different table-order version', () => {
		expect(isCopyResumeOrderCompatible(1, 2)).to.equal(false);
		expect(isCopyResumeOrderCompatible(undefined, 2)).to.equal(false);
		expect(isCopyResumeOrderCompatible(2, 2)).to.equal(true);
	});
});

describe('findLastCommittedLogKey', () => {
	const rangeOf = (keys, flags = {}) =>
		Object.assign(
			keys.map((txnLogKey) => ({ txnLogKey })),
			flags
		);
	const now = 10_000_000;

	it('is the last key the log yields, in append order rather than the largest', () => {
		const store = { getRange: () => rangeOf([now - 10, now - 500, now - 20]) };
		expect(findLastCommittedLogKey(store, 'local', now)).to.equal(now - 20);
	});

	it('widens its window back from now until one holds an entry', () => {
		const starts = [];
		const store = {
			getRange({ start }) {
				starts.push(start);
				return rangeOf([now - 1_000_000].filter((key) => key >= start));
			},
		};
		expect(findLastCommittedLogKey(store, 'local', now)).to.equal(now - 1_000_000);
		expect(starts).to.deep.equal([now - 1_000, now - 60_000, now - 3_600_000]);
	});

	it('is 0 for a log with no committed entry, having finally scanned it from its start', () => {
		const starts = [];
		const store = {
			getRange({ start }) {
				starts.push(start);
				return rangeOf([]);
			},
		};
		expect(findLastCommittedLogKey(store, 'local', now)).to.equal(0);
		expect(starts.at(-1)).to.equal(0);
	});

	it('is undefined when the scan ended short of the watermark', () => {
		const failed = rangeOf([now], { failedLogs: new Set(['local']) });
		expect(findLastCommittedLogKey({ getRange: () => failed }, 'local', now)).to.equal(undefined);
		const corrupt = rangeOf([], { corruptFrameStop: { breaks: 1 } });
		expect(findLastCommittedLogKey({ getRange: () => corrupt }, 'local', now)).to.equal(undefined);
	});

	it('is undefined when the log throws', () => {
		const throwing = {
			getRange() {
				throw new Error('log unavailable');
			},
		};
		expect(findLastCommittedLogKey(throwing, 'local', now)).to.equal(undefined);
	});
});

describe('classifyResumeAnchor', () => {
	const storeYielding = (...entries) => ({ getRange: () => entries });

	it('is entry for an anchor naming an entry of the log, whatever its type', () => {
		expect(classifyResumeAnchor(storeYielding({ type: 'put', txnLogKey: 1000 }), 1000, 'local')).to.equal('entry');
	});

	it('is absent for an anchor naming nothing — a purged entry, or a pre-#876 Date.now() cursor', () => {
		expect(classifyResumeAnchor(storeYielding(), 1000, 'local')).to.equal('absent');
	});

	it('is absent for an anchor that is not a valid log key', () => {
		const store = storeYielding({ txnLogKey: 1000 });
		for (const anchor of [0, -1, NaN, Infinity]) {
			expect(classifyResumeAnchor(store, anchor, 'local')).to.equal('absent');
		}
	});

	it('is absent when the range offers a later entry instead of the one at the anchor', () => {
		expect(classifyResumeAnchor(storeYielding({ txnLogKey: 2000 }), 1000, 'local')).to.equal('absent');
	});

	it('is unreadable when the log throws, distinct from absent even though the caller treats them the same', () => {
		const throwing = {
			getRange() {
				throw new Error('log unavailable');
			},
		};
		expect(classifyResumeAnchor(throwing, 1000, 'local')).to.equal('unreadable');
	});
});
