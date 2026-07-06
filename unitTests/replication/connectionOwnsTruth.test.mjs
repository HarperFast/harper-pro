/**
 * Coverage for `connectionOwnsTruth` — the W1 (harper-pro#431) ownership gate that keeps the per-(db,
 * peer) connection-truth slots (CONNECTION_STATE / LAST_LIVENESS / LAST_ERROR) writable ONLY by the
 * outbound subscription those slots describe. The shared status buffer is keyed solely by (db, peer),
 * so an inbound server connection or a cache-miss retrieval connection to the same peer resolves the
 * same buffer; without this gate they would stamp CONNECTED/liveness for a link the truth is not
 * about, and the main-thread reconcile would up-correct a genuinely-dead subscription to connected
 * (silent replication halt). The discriminator is `nodeSubscriptions`: set by subscribe() and never
 * cleared, never set on a retrieval connection (connect() only) or an inbound connection (no
 * options.connection at all). These tests pin exactly that contract.
 */

import { expect } from 'chai';
import { connectionOwnsTruth } from '#src/replication/replicationConnection';

describe('connectionOwnsTruth', () => {
	it('is true for a subscription connection (nodeSubscriptions set)', () => {
		expect(connectionOwnsTruth({ nodeSubscriptions: [{ name: 'peer' }] })).to.equal(true);
	});

	it('is true even for an empty (but present) subscription array', () => {
		// subscribe([]) still marks ownership; nodeSubscriptions is defined, not undefined.
		expect(connectionOwnsTruth({ nodeSubscriptions: [] })).to.equal(true);
	});

	it('is false for a retrieval connection that only connect()ed (nodeSubscriptions undefined)', () => {
		expect(connectionOwnsTruth({ url: 'wss://peer', nodeSubscriptions: undefined })).to.equal(false);
		expect(connectionOwnsTruth({ url: 'wss://peer' })).to.equal(false);
	});

	it('is false for an inbound/server connection (no options.connection object)', () => {
		expect(connectionOwnsTruth(undefined)).to.equal(false);
		expect(connectionOwnsTruth(null)).to.equal(false);
	});
});
