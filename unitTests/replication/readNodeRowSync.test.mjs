/**
 * Coverage for readNodeRowSync — the synchronous hdb_nodes point-read used by the replication
 * self-gate in subscriptionManager (the `!selfNodeRow?.replicates` "Disabling replication" decision and
 * the identity-mismatch enumeration).
 *
 * Root cause this guards: the system database is RocksDB, whose `get()` returns a MaybePromise — the
 * value synchronously when the row is in the block cache / memtable, but a *Promise* on a cache miss
 * that needs a disk read. The self-gate did an un-awaited `primaryStore.get(getThisNodeName())`, so once
 * `system` grew past block-cache size (or right after a cold-cache restart) the self row was evicted,
 * `get()` returned a Promise, and `(promise)?.replicates` was `undefined` — making the gate believe
 * replication was OFF and silently disabling it (the field wedge: connected:false for hours, retries:0).
 *
 * The fix: readNodeRowSync uses the SYNCHRONOUS point read (`getSync`), which forces the inline read
 * regardless of cache state, so the gate sees the real row whether or not it is cached.
 *
 * (Sibling to selfNodeReplicates.test.mjs, which covers the same bug family in shouldReplicateFromNode.)
 */

import { expect } from 'chai';
import { readNodeRowSync } from '#src/replication/subscriptionManager';

/**
 * Store stub modeling the RocksDB MaybePromise contract.
 * - `get(key)` returns the value synchronously when the key is "cached" (block cache / memtable), and a
 *   resolved Promise on a cache miss — exactly the path that silently broke the old un-awaited gate.
 * - `getSync(key)` always returns the value synchronously (forcing the inline disk read on a miss), and
 *   `undefined` for an absent key.
 */
function rocksLikeStore(disk = {}, cachedKeys = []) {
	const cached = new Set(cachedKeys);
	const has = (key) => Object.prototype.hasOwnProperty.call(disk, key);
	return {
		get(key) {
			if (!has(key)) return undefined;
			return cached.has(key) ? disk[key] : Promise.resolve(disk[key]); // cache miss -> Promise
		},
		getSync(key) {
			return has(key) ? disk[key] : undefined;
		},
	};
}

describe('readNodeRowSync', () => {
	const SELF = 'node-a';

	// THE bug-closing case: the self row is NOT in the block cache, so RocksDB get() returns a Promise.
	// The old un-awaited `get(SELF)?.replicates` read undefined off that Promise (-> "Disabling
	// replication"); readNodeRowSync reads the real row via getSync.
	it('returns the real row on a block-cache MISS (get() would return a Promise)', () => {
		const row = { name: SELF, replicates: true };
		const store = rocksLikeStore({ [SELF]: row } /* cachedKeys: none */);

		// Demonstrate the hazard the fix removes: the async get() yields a Promise, not the record.
		const asyncResult = store.get(SELF);
		expect(typeof asyncResult.then).to.equal('function');
		expect(asyncResult?.replicates).to.equal(undefined); // the old code path -> falsy gate -> disable

		// The fix: the gate sees the real row, so `!row?.replicates` is correctly false (stays enabled).
		const selfNodeRow = readNodeRowSync(store, SELF);
		expect(selfNodeRow).to.deep.equal(row);
		expect(!selfNodeRow?.replicates).to.equal(false);
	});

	it('returns the real row on a cache HIT (get() is synchronous) too', () => {
		const row = { name: SELF, replicates: true };
		const store = rocksLikeStore({ [SELF]: row }, [SELF]);
		expect(readNodeRowSync(store, SELF)).to.deep.equal(row);
	});

	// A genuine replicates:false must be preserved — the legitimate "replication off" case.
	it('preserves a genuine replicates: false row (legitimate replication-off)', () => {
		const row = { name: SELF, replicates: false };
		const store = rocksLikeStore({ [SELF]: row });
		const selfNodeRow = readNodeRowSync(store, SELF);
		expect(selfNodeRow).to.deep.equal(row);
		expect(!selfNodeRow?.replicates).to.equal(true); // correctly treated as off
	});

	// A genuinely-absent self row -> undefined (falsy). The gate then takes the identity-mismatch branch,
	// which is the intended behavior (NOT a Promise that masquerades as a present row).
	it('returns undefined when there is no self row at all', () => {
		const store = rocksLikeStore({});
		expect(readNodeRowSync(store, SELF)).to.equal(undefined);
	});
});
