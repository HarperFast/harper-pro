/**
 * The base-copy resume anchor, and the log property it rests on (harper-pro#876).
 *
 * A transaction's log key is fixed when it is CREATED; its log batch is appended when it COMMITS. The
 * log is therefore written out of key order, so a timestamp cursor is not a boundary in it.
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
	findCopyBarrierTable,
	isCopyResumeOrderCompatible,
} from '#src/replication/replicationConnection';

// Through `require`, not `import`: rocksdb-js decorates the native `TransactionLog` prototype at load,
// and core already loaded its CJS build — a second (ESM) instance redefines that property and throws.
const { RocksDatabase } = createRequire(import.meta.url)('@harperfast/rocksdb-js');

async function withDatabase(run) {
	const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'copy-barrier-'));
	const db = RocksDatabase.open(join(dir, 'db'));
	try {
		await run(db, db.useLog('local'));
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

const payloads = (log, options) => [...log.query(options)].map((entry) => Buffer.from(entry.data).toString());

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
				log.addEntry(Buffer.from('BARRIER'), txn.id);
			});
			release();
			await inFlight;

			expect(inFlightKey).to.be.below(anchor);
			expect(payloads(log, { start: 0 })).to.deep.equal(['BARRIER', 'IN-FLIGHT']);
			expect(payloads(log, { start: anchor, exclusiveStart: true })).to.deep.equal([]);
		}));

	it('resuming past the barrier entry yields it, because append order stops being filtered', async () =>
		withDatabase(async (db, log) => {
			let release;
			const held = new Promise((resolve) => (release = resolve));
			const inFlight = db.transaction(async (txn) => {
				log.addEntry(Buffer.from('IN-FLIGHT'), txn.id);
				await held;
			});
			let anchor;
			await db.transaction((txn) => {
				anchor = txn.getTimestamp();
				log.addEntry(Buffer.from('BARRIER'), txn.id);
			});
			release();
			await inFlight;
			await db.transaction((txn) => log.addEntry(Buffer.from('AFTER'), txn.id));

			// Once `exactStart` matches the boundary the predicate stops consulting the key at all.
			expect(payloads(log, { start: anchor, exactStart: true })).to.deep.equal(['BARRIER', 'IN-FLIGHT', 'AFTER']);

			// And with the boundary itself excluded, which is what the copy's range does: everything
			// appended after it is delivered regardless of key, the barrier included in nothing.
			expect(payloads(log, { start: anchor, exactStart: true, exclusiveStart: true })).to.deep.equal([
				'IN-FLIGHT',
				'AFTER',
			]);
		}));

	it('a committed barrier is a visibility fence for everything appended before it', async () =>
		withDatabase(async (db, log) => {
			// An assumption about the storage engine, so it is pinned rather than described.
			const inFlight = Array.from({ length: 200 }, (_, i) => {
				const key = `k${i}`;
				return db.transaction((txn) => {
					log.addEntry(Buffer.from(key), txn.id);
					db.putSync(key, 1);
				});
			});
			await db.transaction((txn) => log.addEntry(Buffer.from('BARRIER'), txn.id));

			const notYetVisible = [];
			for (const payload of payloads(log, { start: 0 })) {
				if (payload === 'BARRIER') break;
				if (db.getSync(payload) === undefined) notYetVisible.push(payload);
			}
			expect(notYetVisible).to.deep.equal([]);
			await Promise.all(inFlight);
		}));
});

describe('isCopyResumeOrderCompatible', () => {
	it('rejects a cursor from a pre-barrier leader, so its timestamp anchor is discarded with it', () => {
		expect(isCopyResumeOrderCompatible(1, 2)).to.equal(false);
		expect(isCopyResumeOrderCompatible(undefined, 2)).to.equal(false);
		expect(isCopyResumeOrderCompatible(2, 2)).to.equal(true);
	});
});

describe('findCopyBarrierTable', () => {
	const writesBarriers = { writeCopyBarrier: () => Promise.resolve(1) };

	it('takes the first table in copy order, so a resumed copy would pick the same one', () => {
		const tables = { b: writesBarriers, a: writesBarriers };
		expect(findCopyBarrierTable(tables, ['a', 'b'])).to.equal(tables.a);
		expect(findCopyBarrierTable(tables, ['b', 'a'])).to.equal(tables.b);
	});

	it('skips a table that cannot write one rather than failing the copy', () => {
		const tables = { a: {}, b: writesBarriers };
		expect(findCopyBarrierTable(tables, ['a', 'b'])).to.equal(tables.b);
	});

	it('is undefined with no usable table, leaving the caller on the old anchor', () => {
		expect(findCopyBarrierTable(undefined, [])).to.equal(undefined);
		expect(findCopyBarrierTable({ a: {} }, ['a'])).to.equal(undefined);
	});
});

describe('classifyResumeAnchor', () => {
	const storeYielding = (...entries) => ({ getRange: () => entries });
	const atAnchor = (type) => ({ type, txnLogKey: 1000 });

	it('is barrier for an anchor naming a copyBarrier entry', () => {
		expect(classifyResumeAnchor(storeYielding(atAnchor('copyBarrier')), 1000, 'local')).to.equal('barrier');
	});

	it('is other for an anchor naming an ordinary transaction', () => {
		expect(classifyResumeAnchor(storeYielding(atAnchor('put')), 1000, 'local')).to.equal('other');
	});

	it('is other for an anchor naming nothing — a purged barrier, or a pre-#876 Date.now() cursor', () => {
		expect(classifyResumeAnchor(storeYielding(), 1000, 'local')).to.equal('other');
	});

	it('is other for an anchor that is not a valid log key', () => {
		const store = storeYielding(atAnchor('copyBarrier'));
		for (const anchor of [0, -1, NaN, Infinity]) {
			expect(classifyResumeAnchor(store, anchor, 'local')).to.equal('other');
		}
	});

	it('is other when the range offers a later entry instead of the one at the anchor', () => {
		expect(classifyResumeAnchor(storeYielding({ type: 'copyBarrier', txnLogKey: 2000 }), 1000, 'local')).to.equal(
			'other'
		);
	});

	it("is unreadable when the log throws, distinct from other even though today's caller treats them the same", () => {
		const throwing = {
			getRange() {
				throw new Error('log unavailable');
			},
		};
		expect(classifyResumeAnchor(throwing, 1000, 'local')).to.equal('unreadable');
	});
});
