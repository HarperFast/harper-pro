/**
 * The fake store models the engine's post-GC behavior (harper-pro#431): `getUserSharedBuffer` allocates a
 * fresh zeroed buffer on every call, so anything that survives a second resolution survived only because
 * `knownNodes.ts` retained it.
 */

import { expect } from 'chai';
import { getReplicationSharedStatus, clearReplicationSharedStatus } from '#src/replication/knownNodes';
import { REPLICATION_SHARED_STATUS_SLOTS } from '#src/replication/knownNodes';
import { CONNECTION_STATE_POSITION, LAST_ERROR_CODE_POSITION } from '#src/replication/replicationConnection';

function fakeAuditStore() {
	const store = {
		calls: [],
		callbacks: [],
		getUserSharedBuffer(key, defaultBuffer, options) {
			store.calls.push(key.join('/'));
			if (options?.callback) store.callbacks.push(options.callback);
			return new ArrayBuffer(defaultBuffer.byteLength);
		},
	};
	return store;
}

// Each case uses its own database name so one case's retention cannot mask another's.
let nextDatabase = 0;
const database = () => `retention-db-${nextDatabase++}`;

describe('replication shared status retention (harper-pro#431)', () => {
	it('resolves one buffer per (database, peer) so a write survives the next resolution', () => {
		const auditStore = fakeAuditStore();
		const databaseName = database();
		const first = getReplicationSharedStatus(auditStore, databaseName, 'peer-a');
		first[LAST_ERROR_CODE_POSITION] = 100_001;

		const second = getReplicationSharedStatus(auditStore, databaseName, 'peer-a');

		expect(second).to.equal(first);
		expect(second[LAST_ERROR_CODE_POSITION]).to.equal(100_001);
		expect(auditStore.calls).to.deep.equal([`replicated/${databaseName}/peer-a`]);
		expect(first.length).to.equal(REPLICATION_SHARED_STATUS_SLOTS);
	});

	it('keeps peers and databases on separate buffers', () => {
		const auditStore = fakeAuditStore();
		const databaseName = database();
		const otherDatabase = database();
		const peerA = getReplicationSharedStatus(auditStore, databaseName, 'peer-a');
		const peerB = getReplicationSharedStatus(auditStore, databaseName, 'peer-b');
		const otherDb = getReplicationSharedStatus(auditStore, otherDatabase, 'peer-a');

		peerA[CONNECTION_STATE_POSITION] = 2;

		expect(peerB).to.not.equal(peerA);
		expect(otherDb).to.not.equal(peerA);
		expect(peerB[CONNECTION_STATE_POSITION]).to.equal(0);
		expect(otherDb[CONNECTION_STATE_POSITION]).to.equal(0);
	});

	it('drops what it retained for a database when the audit store is replaced', () => {
		const databaseName = database();
		const original = fakeAuditStore();
		const stale = getReplicationSharedStatus(original, databaseName, 'peer-a');
		stale[CONNECTION_STATE_POSITION] = 2;

		const recreated = fakeAuditStore();
		const fresh = getReplicationSharedStatus(recreated, databaseName, 'peer-a');

		expect(fresh).to.not.equal(stale);
		expect(fresh[CONNECTION_STATE_POSITION]).to.equal(0);
		expect(getReplicationSharedStatus(recreated, databaseName, 'peer-a')).to.equal(fresh);
		expect(recreated.calls).to.deep.equal([`replicated/${databaseName}/peer-a`]);
	});

	it('re-resolves through the store when a callback is supplied, so the notifier is registered', () => {
		const auditStore = fakeAuditStore();
		const databaseName = database();
		getReplicationSharedStatus(auditStore, databaseName, 'peer-a');
		const callback = () => {};

		const registered = getReplicationSharedStatus(auditStore, databaseName, 'peer-a', callback);

		expect(auditStore.callbacks).to.deep.equal([callback]);
		expect(auditStore.calls).to.have.lengthOf(2);
		// The callback-bearing view must be the retained one, or the notifier sits on the buffer the engine
		// is free to reclaim.
		expect(getReplicationSharedStatus(auditStore, databaseName, 'peer-a')).to.equal(registered);
	});

	it('releases the retained buffer when the peer leaves, so the engine can reclaim it', () => {
		const auditStore = fakeAuditStore();
		const databaseName = database();
		const before = getReplicationSharedStatus(auditStore, databaseName, 'peer-a');
		before[CONNECTION_STATE_POSITION] = 2;
		before[LAST_ERROR_CODE_POSITION] = 1008;

		expect(clearReplicationSharedStatus(auditStore, databaseName, 'peer-a')).to.equal(true);

		expect(before[CONNECTION_STATE_POSITION]).to.equal(0);
		expect(before[LAST_ERROR_CODE_POSITION]).to.equal(0);
		const reAdded = getReplicationSharedStatus(auditStore, databaseName, 'peer-a');
		expect(reAdded).to.not.equal(before);
	});
});
