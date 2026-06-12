/**
 * Coverage for resolveNodeForAuth — the replication cert/IP auth-path read of hdb_nodes.
 *
 * Root cause (harper-pro#352, field variant #345): during a rolling in-place v4->v5 upgrade, a
 * freshly-flipped node's replication auth path reads a peer's hdb_nodes row via the POINT lookup
 * (`primaryStore.get()`) very early at boot. A v5-era msgpackr *shared-structure* row can
 * transiently misread through that point-lookup path — yielding `[]`/null (it does not necessarily
 * throw) — even though the row and the table's shared structures are present on disk (the misread
 * loses a race with the hdb_nodes base-copy resync that heals it within seconds; the SCAN path
 * lists the key reliably the whole time). The #345 guard (isValidNodeRecord) correctly refuses the
 * misread, but on a replication socket the "require credentials" fallback can never succeed — the
 * peer is rejected with cycling 1008 Unauthorized and its post-flip writes strand at origin.
 *
 * resolveNodeForAuth fixes the wedge at the auth decision: when the point lookup yields no valid
 * record but the key is RANGE-VISIBLE (a known peer), it is recovered to a minimal `{ name }`
 * descriptor (the name is the primary key, which the scan path lists reliably), so a
 * certificate-validated peer is authorized instead of stranded. Keying off range-visibility — not
 * the point-lookup `doesExist`/`get`, which is the very path that misreads — is deliberate. A
 * genuinely unknown (not range-visible) hostname still returns undefined.
 *
 * The first block tests the resolution logic against a fake store modeling each failure mode. The
 * second block proves the *precondition* is real: a v5-era shared-structure row, decoded with its
 * structure table absent, really does fail to decode (it is not a contrived mock).
 */

import { expect } from 'chai';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveNodeForAuth, isValidNodeRecord } from '#src/replication/knownNodes';

/**
 * Minimal store stub. `data` holds decoded values; `present` is the point-lookup existence set
 * (doesExist); `rangeKeys` is the scan-path key set (getKeys) and defaults to `present` unless
 * overridden — overriding it lets a test model the point/range split that is the #352 signature.
 */
function fakeStore({ data = {}, present = null, rangeKeys = null, throwOnGet = new Set() } = {}) {
	const presentSet = present ?? new Set(Object.keys(data));
	const rangeSet = rangeKeys ?? presentSet;
	return {
		get(key) {
			if (throwOnGet.has(key)) throw new Error('Record id is not defined for 0');
			return data[key];
		},
		doesExist(key) {
			return presentSet.has(key);
		},
		// Models lmdb-js getKeys: keys >= start ascending, capped by limit. Never decodes values,
		// which is why the scan path stays reliable while the point lookup transiently misreads.
		getKeys({ start, limit } = {}) {
			const keys = [...rangeSet].sort();
			const from = start == null ? keys : keys.filter((k) => k >= start);
			return limit == null ? from : from.slice(0, limit);
		},
	};
}

describe('resolveNodeForAuth', () => {
	const validRow = { name: 'ipnode4', url: 'wss://ipnode4:9933', subscriptions: [], replicates: true };

	it('returns the decoded record when it is a valid node descriptor', () => {
		const store = fakeStore({ data: { ipnode4: validRow } });
		expect(resolveNodeForAuth(store, 'ipnode4')).to.equal(validRow);
	});

	it('reconstructs { name } when the row is present but decodes to [] (the #345 misread)', () => {
		const store = fakeStore({ data: { ipnode4: [] }, present: new Set(['ipnode4']) });
		expect(resolveNodeForAuth(store, 'ipnode4')).to.deep.equal({ name: 'ipnode4' });
	});

	it('reconstructs { name } when the row is present but decodes to null', () => {
		const store = fakeStore({ data: { ipnode4: null }, present: new Set(['ipnode4']) });
		expect(resolveNodeForAuth(store, 'ipnode4')).to.deep.equal({ name: 'ipnode4' });
	});

	it('reconstructs { name } when get() throws (missing shared structure) but the row exists', () => {
		const store = fakeStore({ present: new Set(['ipnode4']), throwOnGet: new Set(['ipnode4']) });
		expect(resolveNodeForAuth(store, 'ipnode4')).to.deep.equal({ name: 'ipnode4' });
	});

	it('reconstructs { name } when range-visible even though the point lookup (doesExist) is falsy', () => {
		// THE observed #352 shape: the scan path lists the peer while the point lookup misreads. The
		// fix must key off range-visibility, NOT doesExist (the path that fails), or the wedge stays open.
		const store = fakeStore({ data: { ipnode4: [] }, present: new Set(), rangeKeys: new Set(['ipnode4']) });
		expect(store.doesExist('ipnode4')).to.equal(false); // point lookup claims "absent"
		expect(resolveNodeForAuth(store, 'ipnode4')).to.deep.equal({ name: 'ipnode4' });
	});

	it('returns undefined when the hostname is genuinely unknown (not range-visible, no route)', () => {
		const store = fakeStore({ data: {}, present: new Set() });
		expect(resolveNodeForAuth(store, 'stranger')).to.equal(undefined);
	});

	it('prefers a valid static-route record over a key reconstruction (keeps revoked_certificates etc.)', () => {
		const store = fakeStore({ data: { ipnode4: [] }, present: new Set(['ipnode4']) });
		const route = { name: 'ipnode4', url: 'wss://ipnode4:9933', revoked_certificates: ['abc'] };
		expect(resolveNodeForAuth(store, 'ipnode4', route)).to.equal(route);
	});

	it('does not reconstruct for an unknown hostname even with an invalid route record', () => {
		const store = fakeStore({ data: {}, present: new Set() });
		expect(resolveNodeForAuth(store, 'stranger', [])).to.equal(undefined);
	});
});

describe('readNodeForAuth precondition (real msgpackr shared-structure decode)', () => {
	it('a v5-era shared-structure row fails to decode when its structure table is absent', async () => {
		const { Packr } = await import('msgpackr');
		// Writer mints + persists a shared structure (the v5 envelope), then references it by id.
		let structures;
		const writer = new Packr({
			useRecords: true,
			maxSharedStructures: 32,
			getStructures: () => structures,
			saveStructures: (s) => {
				structures = s.slice();
				return true;
			},
		});
		writer.pack({ name: 'ipnode4', url: 'wss://ipnode4:9933', subscriptions: [], replicates: true });
		const bytes = writer.pack({ name: 'ipnode4', url: 'wss://ipnode4:9933', subscriptions: [], replicates: true });
		// The value bytes begin with a record-id reference (0x40 == id 0), proving it is by-id.
		expect(bytes[0] & 0xe0).to.equal(0x40);

		// Late-flipped node: the structure table was never persisted on this node, so decode fails.
		const readerMissing = new Packr({ useRecords: true, maxSharedStructures: 32, getStructures: () => undefined });
		let decodedMissing, threw = false;
		try {
			decodedMissing = readerMissing.unpack(bytes);
		} catch {
			threw = true;
		}
		// Either path (throw, or a non-node value) is what trips isValidNodeRecord in production.
		expect(threw || decodedMissing == null || typeof decodedMissing?.name !== 'string').to.equal(true);

		// Control: with the structure table present, the same bytes decode to the full node row.
		const readerOk = new Packr({ useRecords: true, maxSharedStructures: 32, getStructures: () => structures });
		expect(readerOk.unpack(bytes)).to.deep.equal({
			name: 'ipnode4',
			url: 'wss://ipnode4:9933',
			subscriptions: [],
			replicates: true,
		});
	});
});

/**
 * Authoritative regression for harper-pro#352.
 *
 * The lab e2e (incidents/inplace-upgrade-2026-06-11) does NOT reliably reproduce the wedge: the
 * trigger is timing-dependent (a v5-era shared-structure hdb_nodes row must misread on the point
 * lookup at boot before the resync heals it), and baseline beta.3 passed the lab gates in our runs.
 * This test reproduces the *auth-path condition* deterministically — a row that is present and
 * range-visible but fails to decode through the point lookup — using a real `lmdb` store (not a
 * hand-rolled fake; here the decode fails because the structure table is absent, the durable
 * variant of production's transient misread), then drives the production resolution logic and
 * asserts the end-to-end auth contract that the bug broke.
 *
 * Layer exercised: `resolveNodeForAuth(store, name, routeRecord)` — the pure core of
 * `readNodeForAuth(name)`, which in production reads `getHDBNodeTable().primaryStore`. We pass the
 * real lmdb store directly rather than stand up `system.hdb_nodes`, which would require a running
 * server; per the task brief this is acceptable and still authoritative because the store reads
 * through the identical decode-throw / physical-existence path the auth site hits.
 */
describe('resolveNodeForAuth against a real lmdb shared-structure store (harper-pro#352)', () => {
	let lmdbDir;
	let undecodableStore; // structures table absent -> get() throws (the late-flipped-node condition)
	let emptyStore; // genuinely empty store -> unknown hostname must stay unknown

	before(async () => {
		const { open } = await import('lmdb');
		lmdbDir = path.join(os.tmpdir(), `harper-352-${process.pid}-${Date.now()}`);
		fs.mkdirSync(lmdbDir, { recursive: true });

		// Phase 1 — an already-flipped v5 peer writes the hdb_nodes row with msgpackr shared
		// structures enabled. The value bytes become a by-id record reference; the structure table
		// that defines that id lives under Symbol.for('structures') in this env.
		const writerDb = open({
			path: path.join(lmdbDir, 'hdb_nodes'),
			encoding: 'msgpack',
			sharedStructuresKey: Symbol.for('structures'),
		});
		await writerDb.put('ipnode4', {
			name: 'ipnode4',
			url: 'wss://ipnode4:9933',
			subscriptions: [],
			replicates: true,
		});
		// Prove the on-disk value really is a by-id shared-structure reference (0x40 == record id 0),
		// i.e. it cannot be decoded without the structure table — the v5-era envelope.
		const raw = writerDb.getBinary('ipnode4');
		expect(raw[0] & 0xe0).to.equal(0x40);
		await writerDb.close();

		// Phase 2 — reopen the store so the point decode fails (here by opening WITHOUT
		// sharedStructuresKey, so the defining structure can't be resolved): get() throws while the
		// row stays present and range-visible (doesExist/getKeys still list the key). This is the
		// auth-path condition replicator.ts hits — production reaches it transiently (the structures
		// are on disk but the point read loses a boot race); this is its durable, deterministic proxy.
		undecodableStore = open({ path: path.join(lmdbDir, 'hdb_nodes'), encoding: 'msgpack' });

		emptyStore = open({ path: path.join(lmdbDir, 'empty'), encoding: 'msgpack' });
	});

	after(async () => {
		await undecodableStore?.close();
		await emptyStore?.close();
		if (lmdbDir) fs.rmSync(lmdbDir, { recursive: true, force: true });
	});

	it('the real store reproduces the failure mode: get() throws but the row physically exists', () => {
		expect(() => undecodableStore.get('ipnode4')).to.throw();
		expect(undecodableStore.doesExist('ipnode4')).to.equal(true);
	});

	it('resolveNodeForAuth recovers a { name } descriptor for the present-but-undecodable row', () => {
		const resolved = resolveNodeForAuth(undecodableStore, 'ipnode4');
		expect(resolved).to.deep.equal({ name: 'ipnode4' });
	});

	// THE wedge-closing assertion: this is the exact gate in replicator.ts that decides
	// "node found -> authorize the cert-validated peer" vs "no node -> require credentials -> 1008".
	// Before the fix the undecodable row failed this gate and stranded the peer; it must now pass.
	it('the recovered descriptor satisfies isValidNodeRecord (peer authorized, not 1008)', () => {
		const resolved = resolveNodeForAuth(undecodableStore, 'ipnode4');
		expect(isValidNodeRecord(resolved)).to.equal(true);
	});

	// Negative case against the same real-store machinery: a genuinely absent key (no row, no route)
	// still yields undefined -> isValidNodeRecord false -> auth correctly requires credentials. The
	// fix recovers undecodable *known* peers, it does not authorize unknown hostnames.
	it('a genuinely unknown hostname still resolves to undefined (credentials required)', () => {
		const resolved = resolveNodeForAuth(emptyStore, 'stranger');
		expect(resolved).to.equal(undefined);
		expect(isValidNodeRecord(resolved)).to.equal(false);
	});
});
