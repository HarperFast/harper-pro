/**
 * Coverage for readDbisCursorSync — the synchronous __dbis__ point-read the subscription handshake uses
 * to resolve a per-source replication resume cursor (`seq` / `copyCursor`).
 *
 * Root cause this guards: __dbis__ is RocksDB, whose `get()` returns a MaybePromise — the value
 * synchronously when the key is in the block cache / memtable, but a *Promise* on a cache miss that needs
 * a disk read. The handshake (replicationConnection.ts) read the seq cursor with an un-awaited
 * `dbisDB.get([Symbol.for('seq'), nodeId])`. Right after a restart/upgrade — exactly when the handshake
 * runs — the seq key is cold, so get() returned a Promise; `Promise?.seqId` is undefined, startTime fell
 * to 1, and the "no resume cursor for this source" branch forced an UNNECESSARY FULL COPY of a node that
 * actually held a valid persisted cursor. The bigger the system DB, the more block-cache pressure, the
 * likelier the eviction — so large customer databases (e.g. 1TB) full-copy on a routine upgrade while
 * small ones resume incrementally.
 *
 * The fix: readDbisCursorSync uses the SYNCHRONOUS point read (`getSync`), which forces the inline read
 * regardless of cache state, so the handshake sees the real cursor whether or not it is cached. Mirrors
 * the writer (core Table.ts updateRecordedSequenceId) and the prior hdb_nodes sweep (#476/#474/#470,
 * see readNodeRowSync.test.mjs / selfNodeReplicates.test.mjs).
 */

import { expect } from 'chai';
import { readDbisCursorSync } from '#src/replication/replicationConnection';

/**
 * __dbis__ store stub modeling the RocksDB MaybePromise contract.
 * - `get(key)` returns the value synchronously when the key is "cached" (block cache / memtable), and a
 *   resolved Promise on a cache miss — the path that silently broke the old un-awaited handshake read.
 * - `getSync(key)` always returns the value synchronously (forcing the inline disk read on a miss), and
 *   `undefined` for an absent key.
 *
 * Keys are tuples `[Symbol.for(kind), id]`; we serialize them to a stable string for the backing map.
 */
function rocksLikeDbis(disk = {}, cachedKeys = []) {
	const keyStr = (key) => `${key[0].toString()}|${String(key[1])}`;
	const cached = new Set(cachedKeys);
	const has = (key) => Object.prototype.hasOwnProperty.call(disk, keyStr(key));
	return {
		get(key) {
			if (!has(key)) return undefined;
			return cached.has(keyStr(key)) ? disk[keyStr(key)] : Promise.resolve(disk[keyStr(key)]); // miss -> Promise
		},
		getSync(key) {
			return has(key) ? disk[keyStr(key)] : undefined;
		},
	};
}

const NODE_ID = 7;
const seqKeyStr = `${Symbol.for('seq').toString()}|${NODE_ID}`;
const copyKeyStr = `${Symbol.for('copyCursor').toString()}|${NODE_ID}`;

describe('readDbisCursorSync', () => {
	// THE bug-closing case: the seq row is NOT in the block cache, so RocksDB get() returns a Promise.
	// The old un-awaited `get([seq, id])?.seqId` read undefined off that Promise -> startTime 1 -> full
	// copy; readDbisCursorSync reads the real cursor via getSync.
	it('returns the real seq cursor on a block-cache MISS (get() would return a Promise)', () => {
		const row = { seqId: 42, nodes: [] };
		const dbis = rocksLikeDbis({ [seqKeyStr]: row } /* cachedKeys: none */);

		// Demonstrate the hazard the fix removes: the async get() yields a Promise, not the cursor, and
		// the resume decision collapses to a full copy.
		const asyncResult = dbis.get([Symbol.for('seq'), NODE_ID]);
		expect(typeof asyncResult.then).to.equal('function');
		expect(asyncResult?.seqId).to.equal(undefined);
		const oldStartTime = asyncResult?.seqId ?? 1; // old code path
		expect(oldStartTime).to.equal(1); // -> "no resume cursor" -> startTime 0 / full copy

		// The fix: the handshake sees the real cursor, resumes from the persisted seqId, no full copy.
		const cursor = readDbisCursorSync(dbis, 'seq', NODE_ID);
		expect(cursor).to.deep.equal(row);
		const newStartTime = cursor?.seqId ?? 1;
		expect(newStartTime).to.equal(42);
		// hasPersistedResumeCursor = (seqId ?? 0) > 1 — true here (resume), false on the broken path.
		expect((cursor?.seqId ?? 0) > 1).to.equal(true);
	});

	it('returns the real seq cursor on a cache HIT (get() is synchronous) too', () => {
		const row = { seqId: 42, nodes: [] };
		const dbis = rocksLikeDbis({ [seqKeyStr]: row }, [seqKeyStr]);
		expect(readDbisCursorSync(dbis, 'seq', NODE_ID)).to.deep.equal(row);
	});

	// copyCursor variant: a Promise on a miss would be treated as malformed/absent by
	// discardMalformedCopyCursor, dropping a valid interrupted-copy resume point.
	it('returns the real copyCursor on a block-cache MISS', () => {
		const cursor = { copyStartTime: 1000, currentTable: 'dog', afterKey: 5 };
		const dbis = rocksLikeDbis({ [copyKeyStr]: cursor } /* not cached */);
		expect(typeof dbis.get([Symbol.for('copyCursor'), NODE_ID]).then).to.equal('function'); // hazard
		expect(readDbisCursorSync(dbis, 'copyCursor', NODE_ID)).to.deep.equal(cursor);
	});

	// A genuinely-absent cursor -> undefined (falsy). This is the legitimate fresh-subscription /
	// full-copy case, distinct from a Promise masquerading as a present cursor.
	it('returns undefined when the cursor row is genuinely absent', () => {
		const dbis = rocksLikeDbis({});
		expect(readDbisCursorSync(dbis, 'seq', NODE_ID)).to.equal(undefined);
		expect(readDbisCursorSync(dbis, 'copyCursor', NODE_ID)).to.equal(undefined);
	});

	// Optional-chains through a missing store rather than throwing (matches `dbisDB?.` at the call sites).
	it('tolerates an undefined store', () => {
		expect(readDbisCursorSync(undefined, 'seq', NODE_ID)).to.equal(undefined);
	});
});
