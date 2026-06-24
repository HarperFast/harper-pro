/**
 * Coverage for selfNodeReplicates — the "does THIS node participate in replication" self-record read at
 * the end of shouldReplicateFromNode (replication/knownNodes.ts).
 *
 * Root cause of the observed preprod wedge (CDP-confirmed on the live cluster): the system database is
 * RocksDB, whose `get()` returns a MaybePromise — the value synchronously when the row is in the block
 * cache / memtable, but a *Promise* on a cache miss that needs a disk read. The replication self-gate did
 * an un-awaited `primaryStore.get(getThisNodeName())?.replicates`, so once `system` grew past block-cache
 * size the self row was evicted, `get()` returned a Promise, and `(promise)?.replicates` was `undefined`
 * — making the WHOLE shouldReplicateFromNode predicate falsy. That predicate is the `isDesired` gate for
 * BOTH the wedge backstop (findWedgedNodeUrls -> reconcileWorkers) AND the onDatabase re-subscribe path,
 * so a still-desired peer was silently excluded from all recovery (connected:false for hours, retries:0).
 *
 * The fix: selfNodeReplicates uses the SYNCHRONOUS point read (`getSync`), which forces the inline read
 * regardless of cache state. A deleted/absent self-record yields null/undefined (falsy, correct); a
 * genuine replicates:false is preserved.
 */

import { expect } from 'chai';
import { selfNodeReplicates } from '#src/replication/knownNodes';

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

describe('selfNodeReplicates', () => {
	const SELF = 'node-a';

	// THE bug-closing case: the self row is NOT in the block cache, so RocksDB get() returns a Promise.
	// The old un-awaited `get(SELF)?.replicates` read undefined off that Promise; getSync reads the value.
	it('returns the real replicates value on a block-cache MISS (get() returns a Promise)', () => {
		const store = rocksLikeStore({ [SELF]: { name: SELF, replicates: true } } /* cachedKeys: none */);
		// Demonstrate the hazard the fix removes: the async get() yields a Promise, not the record.
		const asyncResult = store.get(SELF);
		expect(typeof asyncResult.then).to.equal('function');
		expect(asyncResult?.replicates).to.equal(undefined); // the old code path -> falsy gate -> wedge
		// The fix:
		expect(selfNodeReplicates(store, SELF)).to.equal(true);
	});

	it('returns the real replicates value on a cache HIT (get() is synchronous) too', () => {
		const store = rocksLikeStore({ [SELF]: { name: SELF, replicates: true } }, [SELF]);
		expect(selfNodeReplicates(store, SELF)).to.equal(true);
	});

	it('returns a replicates OBJECT verbatim (sends/sendsTo form)', () => {
		const replicates = { sends: true, sendsTo: ['node-b'] };
		const store = rocksLikeStore({ [SELF]: { name: SELF, replicates } });
		expect(selfNodeReplicates(store, SELF)).to.deep.equal(replicates);
	});

	// False-positive guard: a genuine, decodable replicates:false must be preserved, not coerced truthy.
	it('preserves a genuine replicates: false (does not force true)', () => {
		const store = rocksLikeStore({ [SELF]: { name: SELF, replicates: false } });
		expect(selfNodeReplicates(store, SELF)).to.equal(false);
	});

	// A genuinely-absent self-record stays undefined (falsy) — we do not invent a self record.
	it('returns undefined when there is no self-record at all', () => {
		const store = rocksLikeStore({});
		expect(selfNodeReplicates(store, SELF)).to.equal(undefined);
	});

	// A removed-node tombstone is a clean null; `?.replicates` is undefined (falsy) — do NOT revive it.
	it('returns undefined for a clean-null tombstone (does NOT revive a removed node)', () => {
		const store = rocksLikeStore({ [SELF]: null });
		expect(selfNodeReplicates(store, SELF)).to.equal(undefined);
	});
});
