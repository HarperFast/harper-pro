/**
 * Coverage for isValidNodeRecord — guards the cert/IP auth path in replicator.ts from
 * treating corrupt or partial-decoded hdb_nodes values as a matched peer.
 *
 * Background (harper-pro#345): on a v4-to-v5 upgraded cluster, `primaryStore.get()` for an
 * existing v5 peer's hostname returned `[]` (empty array) instead of the node record. The
 * cert lookup loop's `if (node) break` treated the truthy `[]` as a match, short-circuited
 * the IP fallback, and the connection ended without a usable `request.user` — replication
 * rejected with 1008 Unauthorized on every database except `system`.
 */

import { expect } from 'chai';
import { isValidNodeRecord } from '#src/replication/knownNodes';

describe('isValidNodeRecord', () => {
	it('accepts a node record with a name', () => {
		expect(isValidNodeRecord({ name: 'node-a', url: 'wss://node-a:9933' })).to.equal(true);
	});

	it('accepts a node record with a url but no name', () => {
		expect(isValidNodeRecord({ url: 'wss://node-a:9933' })).to.equal(true);
	});

	it('rejects null', () => {
		expect(isValidNodeRecord(null)).to.equal(false);
	});

	it('rejects undefined', () => {
		expect(isValidNodeRecord(undefined)).to.equal(false);
	});

	it('rejects an empty array (the harper-pro#345 case)', () => {
		expect(isValidNodeRecord([])).to.equal(false);
	});

	it('rejects an array of node-shaped objects', () => {
		expect(isValidNodeRecord([{ name: 'node-a' }])).to.equal(false);
	});

	it('rejects an object that has neither name nor url', () => {
		expect(isValidNodeRecord({ subscriptions: [], replicates: true })).to.equal(false);
	});

	it('rejects primitives', () => {
		expect(isValidNodeRecord('node-a')).to.equal(false);
		expect(isValidNodeRecord(42)).to.equal(false);
		expect(isValidNodeRecord(true)).to.equal(false);
	});
});
