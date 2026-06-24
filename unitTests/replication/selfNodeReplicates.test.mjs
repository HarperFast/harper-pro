/**
 * Coverage for selfNodeReplicates — the "does THIS node participate in replication" self-record read at
 * the end of shouldReplicateFromNode (replication/knownNodes.ts).
 *
 * Root cause of the observed wedge (4-node preprod cluster, CDP-confirmed): on a repeatedly-upgraded
 * node, the node's OWN hdb_nodes record read via the POINT lookup
 * (`primaryStore.get(getThisNodeName())`) decoded to an empty/undecodable value (the harper-pro#352
 * shared-structure point-lookup misread; the "did not decode to a valid node descriptor on the point
 * lookup" warning was present). `?.replicates` was therefore `undefined`, which made the WHOLE
 * shouldReplicateFromNode predicate falsy. Because that predicate is the `isDesired` gate for BOTH the
 * wedge backstop (findWedgedNodeUrls → reconcileWorkers) AND the onDatabase re-subscribe path, a
 * still-desired peer was silently excluded from all recovery: connected:false for hours, retries:0.
 *
 * selfNodeReplicates closes the wedge: it prefers the real `replicates` from the point lookup, falls back
 * to the RANGE/scan decode (which reliably decodes v5-era shared-structure rows while the point lookup
 * misreads), and only defaults to `true` (the add_node-written self default) when the row is
 * range-visible but no decodable descriptor exists. A genuine `replicates: false` and a genuinely-absent
 * self-record are both preserved.
 */

import { expect } from 'chai';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { selfNodeReplicates } from '#src/replication/knownNodes';

/**
 * Minimal store stub. `data` holds decoded point-lookup values; `rangeData` holds the values the scan
 * path (getRange) decodes — overriding it lets a test model the point/range split that is the #352
 * signature (point misreads, scan decodes). `rangeKeys` is the scan-path key set (defaults to the
 * rangeData/data keys). `throwOnGet` models a present-but-undecodable row that throws on point lookup.
 */
function fakeStore({ data = {}, rangeData = null, rangeKeys = null, throwOnGet = new Set() } = {}) {
	const rangeMap = rangeData ?? data;
	const rangeSet = rangeKeys ?? new Set(Object.keys(rangeMap));
	return {
		get(key) {
			if (throwOnGet.has(key)) throw new Error('Record id is not defined for 0');
			return data[key];
		},
		// Models lmdb-js getRange: entries with key >= start ascending, capped by limit. The scan path
		// decodes v5-era rows reliably while the point lookup transiently misreads.
		getRange({ start, limit } = {}) {
			const keys = [...rangeSet].sort();
			const from = start == null ? keys : keys.filter((k) => k >= start);
			const sliced = limit == null ? from : from.slice(0, limit);
			return sliced.map((key) => ({ key, value: rangeMap[key] }));
		},
		// Models lmdb-js getKeys (used by storeRecordRangeVisible): keys >= start ascending, capped by
		// limit. Never decodes values, which is why range-visibility stays reliable under #352.
		getKeys({ start, limit } = {}) {
			const keys = [...rangeSet].sort();
			const from = start == null ? keys : keys.filter((k) => k >= start);
			return limit == null ? from : from.slice(0, limit);
		},
	};
}

describe('selfNodeReplicates', () => {
	const SELF = 'node-a';

	it('returns the point-lookup replicates value when the self record decodes (replicates: true)', () => {
		const store = fakeStore({ data: { [SELF]: { name: SELF, replicates: true } } });
		expect(selfNodeReplicates(store, SELF)).to.equal(true);
	});

	it('returns the point-lookup replicates object when the self record carries a replicates object', () => {
		const replicates = { sends: true, sendsTo: ['node-b'] };
		const store = fakeStore({ data: { [SELF]: { name: SELF, replicates } } });
		expect(selfNodeReplicates(store, SELF)).to.deep.equal(replicates);
	});

	// THE bug-closing case: point lookup misreads (undecodable []), but the scan path decodes the real
	// record carrying replicates: true. Before the fix `?.replicates` on the [] misread was undefined →
	// predicate falsy → recovery disabled. The fix recovers `true` from the scan path.
	it('recovers replicates from the RANGE/scan record when the point lookup misreads to [] (#352)', () => {
		const store = fakeStore({
			data: { [SELF]: [] }, // point lookup misreads
			rangeData: { [SELF]: { name: SELF, replicates: true } }, // scan decodes the real row
		});
		expect(selfNodeReplicates(store, SELF)).to.equal(true);
	});

	it('recovers replicates from the scan record when the point lookup throws (missing shared structure)', () => {
		const store = fakeStore({
			throwOnGet: new Set([SELF]),
			rangeData: { [SELF]: { name: SELF, replicates: true } },
		});
		expect(selfNodeReplicates(store, SELF)).to.equal(true);
	});

	// Default-when-no-decodable-self-record safety: row is range-visible but neither the point lookup nor
	// the scan can decode a valid descriptor. add_node always writes the self record with replicates:true,
	// so the safe recovery default is true (the observed wedge: the self row never decoded on this node).
	it('defaults to true when the self key is range-visible but nothing decodes anywhere', () => {
		const store = fakeStore({
			data: { [SELF]: [] }, // point lookup misreads
			rangeData: { [SELF]: null }, // scan also can't decode a valid descriptor
			rangeKeys: new Set([SELF]), // but the key is range-visible
		});
		expect(selfNodeReplicates(store, SELF)).to.equal(true);
	});

	// False-positive guard: a genuine, decodable replicates:false must NOT be overridden to true. A node
	// legitimately configured not to replicate stays excluded.
	it('preserves a genuine replicates: false from the point lookup (does not force true)', () => {
		const store = fakeStore({ data: { [SELF]: { name: SELF, replicates: false } } });
		expect(selfNodeReplicates(store, SELF)).to.equal(false);
	});

	it('preserves a genuine replicates: false recovered from the scan path (point lookup misreads)', () => {
		const store = fakeStore({
			data: { [SELF]: [] }, // point lookup misreads
			rangeData: { [SELF]: { name: SELF, replicates: false } }, // scan decodes a genuine false
		});
		expect(selfNodeReplicates(store, SELF)).to.equal(false);
	});

	// A genuinely-absent self-record (not range-visible) stays undefined (falsy) — we do not invent a self
	// record where there is none.
	it('returns undefined when there is no self-record at all (not range-visible)', () => {
		const store = fakeStore({ data: {} });
		expect(selfNodeReplicates(store, SELF)).to.equal(undefined);
	});
});

/**
 * Authoritative regression against a real lmdb shared-structure store: writes the self hdb_nodes row with
 * msgpackr shared structures (the v5 envelope), then reopens WITHOUT the structures key so the POINT
 * lookup throws while the row stays range-visible — the durable, deterministic proxy for production's
 * transient #352 misread. Mirrors readNodeForAuth.test.mjs's real-store block. Proves selfNodeReplicates
 * recovers replicates:true (re-enabling recovery) instead of returning undefined (the wedge).
 */
describe('selfNodeReplicates against a real lmdb shared-structure store (harper-pro#352)', () => {
	let lmdbDir;
	let undecodableStore; // structures table absent -> point get() throws; scan also can't decode here
	let emptyStore;

	before(async () => {
		const { open } = await import('lmdb');
		lmdbDir = path.join(os.tmpdir(), `harper-self-replicate-${process.pid}-${Date.now()}`);
		fs.mkdirSync(lmdbDir, { recursive: true });

		const writerDb = open({
			path: path.join(lmdbDir, 'hdb_nodes'),
			encoding: 'msgpack',
			sharedStructuresKey: Symbol.for('structures'),
		});
		await writerDb.put('node-a', { name: 'node-a', url: 'wss://node-a:9933', subscriptions: [], replicates: true });
		const raw = writerDb.getBinary('node-a');
		// Prove the on-disk value is a by-id shared-structure reference (0x40 == record id 0).
		expect(raw[0] & 0xe0).to.equal(0x40);
		await writerDb.close();

		// Reopen WITHOUT sharedStructuresKey: the point decode throws while the row stays range-visible.
		undecodableStore = open({ path: path.join(lmdbDir, 'hdb_nodes'), encoding: 'msgpack' });
		emptyStore = open({ path: path.join(lmdbDir, 'empty'), encoding: 'msgpack' });
	});

	after(async () => {
		await undecodableStore?.close();
		await emptyStore?.close();
		if (lmdbDir) fs.rmSync(lmdbDir, { recursive: true, force: true });
	});

	it('the real store reproduces the failure: point get() throws but the row is range-visible', () => {
		expect(() => undecodableStore.get('node-a')).to.throw();
		let visible = false;
		for (const key of undecodableStore.getKeys({ start: 'node-a', limit: 1 })) visible = key === 'node-a';
		expect(visible).to.equal(true);
	});

	// THE wedge-closing assertion: before the fix the undecodable self row yielded undefined → predicate
	// falsy → recovery disabled. selfNodeReplicates must now recover a truthy value (the range-visibility
	// default, since this durable proxy also can't decode the row through the scan path either).
	it('selfNodeReplicates recovers a truthy replicates for the present-but-undecodable self row', () => {
		expect(selfNodeReplicates(undecodableStore, 'node-a')).to.equal(true);
	});

	it('returns undefined for a genuinely-absent self-record (empty store)', () => {
		expect(selfNodeReplicates(emptyStore, 'node-a')).to.equal(undefined);
	});
});
