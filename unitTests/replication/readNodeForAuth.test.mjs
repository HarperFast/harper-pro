/**
 * Coverage for resolveNodeForAuth — the replication cert/IP auth-path read of hdb_nodes.
 *
 * Root cause (harper-pro#352, field variant #345): during a rolling in-place v4->v5 upgrade, a
 * node still on v4 receives v5-encoded hdb_nodes rows from already-flipped peers. Those rows are
 * msgpackr *shared-structure* records (the value bytes only reference a structure id), but v4 never
 * persists the `Symbol.for('structures')` table that defines that id. When the node flips to v5 and
 * the auth path reads the row, there is no structure to resolve the id, so msgpackr throws and the
 * decode yields null/`[]`. The #345 guard (isValidNodeRecord) correctly refuses the misread, but on
 * a replication socket the "require credentials" fallback can never succeed — the peer is rejected
 * with cycling 1008 Unauthorized and its post-flip writes strand at origin.
 *
 * resolveNodeForAuth fixes the wedge at the auth decision: a present-but-undecodable row is
 * recovered to a minimal `{ name }` descriptor (the name is the primary key, which is always
 * available), so a certificate-validated peer is authorized instead of stranded. A genuinely
 * unknown hostname still returns undefined.
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

/** Minimal store stub: `data` holds decoded values; `present` is the byte-level existence set. */
function fakeStore({ data = {}, present = null, throwOnGet = new Set() } = {}) {
	const presentSet = present ?? new Set(Object.keys(data));
	return {
		get(key) {
			if (throwOnGet.has(key)) throw new Error('Record id is not defined for 0');
			return data[key];
		},
		doesExist(key) {
			return presentSet.has(key);
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

	it('returns undefined when the hostname is genuinely unknown (no row, no route)', () => {
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
 * trigger is timing-dependent (a v5-era hdb_nodes row must land on a node before it flips), and
 * baseline beta.3 passed the lab gates in our runs. This test reproduces the *exact on-disk
 * condition* deterministically — a present-but-undecodable shared-structure row — using a real
 * `lmdb` store (not a hand-rolled fake), then drives the production resolution logic and asserts
 * the end-to-end auth contract that the bug broke.
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

		// Phase 2 — the late-flipped node reads the same data WITHOUT the shared-structures table
		// (v4 never persisted Symbol.for('structures'); reopening without sharedStructuresKey models
		// that the defining structure is absent on this node). get() now throws on decode, while the
		// row physically exists (doesExist === true). This is the exact replicator.ts auth condition.
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
