/**
 * Coverage for R2 (harper-pro#431): a removed node must not leave its shared status behind. The buffer is
 * keyed by (database, peer) and process-scoped, so a node removed and re-added inside one process resolves
 * the SAME buffer — without a reset the new membership inherits the old one's CONNECTED state, liveness,
 * close code and fire counters, and reads healthy before it has connected once.
 *
 * The reset covers the whole buffer, not just the truth slots, because every field in it — progress
 * watermarks, blob-failure counts, recovery-fire counts — describes the membership that just left. The one
 * exception is the record-lock digest change count, which must only increase.
 */

import { expect } from 'chai';
import { clearReplicationSharedStatus, REPLICATION_SHARED_STATUS_SLOTS } from '#src/replication/knownNodes';
import { RECORD_LOCK_HOMES_DIGEST_CHANGES_POSITION } from '#src/replication/sharedStatusSlots';
import {
	CONNECTION_STATE_POSITION,
	LAST_LIVENESS_TIME_POSITION,
	LAST_ERROR_CODE_POSITION,
	CONNECTION_STATE_CONNECTED,
	deriveConnectionTruth,
	readFireCounters,
	recordFire,
} from '#src/replication/replicationConnection';

const NOW = 1_700_000_000_000;

// Stands in for the auditStore: getUserSharedBuffer hands back the SAME ArrayBuffer for a repeated key,
// which is exactly the same-process re-add behavior this reset exists for.
function makeAuditStore() {
	const buffers = new Map();
	return {
		buffers,
		getUserSharedBuffer(key, defaultBuffer) {
			const id = key.join('|');
			let buffer = buffers.get(id);
			if (!buffer) buffers.set(id, (buffer = defaultBuffer));
			return buffer;
		},
	};
}

function statusFor(auditStore, database, nodeName) {
	return new Float64Array(auditStore.getUserSharedBuffer(['replicated', database, nodeName]));
}

function seed(auditStore, database, nodeName) {
	return new Float64Array(
		auditStore.getUserSharedBuffer(
			['replicated', database, nodeName],
			new ArrayBuffer(REPLICATION_SHARED_STATUS_SLOTS * 8)
		)
	);
}

describe('clearReplicationSharedStatus', () => {
	it('zeroes every slot but the digest change count, which moves on, so a same-process re-add starts from nothing', () => {
		const auditStore = makeAuditStore();
		const status = seed(auditStore, 'data', 'peer');
		status.fill(7);
		const changes = () => new Int32Array(status.buffer)[RECORD_LOCK_HOMES_DIGEST_CHANGES_POSITION * 2];
		const before = changes();

		expect(clearReplicationSharedStatus(auditStore, 'data', 'peer')).to.equal(true);
		const after = Array.from(statusFor(auditStore, 'data', 'peer'));
		expect(
			after.every((slot, position) => slot === 0 || position === RECORD_LOCK_HOMES_DIGEST_CHANGES_POSITION)
		).to.equal(true);
		expect(changes()).to.equal(before + 1);
	});

	it('leaves the re-added membership reading not-connected with no inherited error or counters', () => {
		const auditStore = makeAuditStore();
		const status = seed(auditStore, 'data', 'peer');
		status[CONNECTION_STATE_POSITION] = CONNECTION_STATE_CONNECTED;
		status[LAST_LIVENESS_TIME_POSITION] = NOW - 1000;
		status[LAST_ERROR_CODE_POSITION] = 1008;
		recordFire(status, 'receive-watchdog', 'load-bearing');
		expect(deriveConnectionTruth(status, NOW).connected).to.equal(true);

		clearReplicationSharedStatus(auditStore, 'data', 'peer');

		const truth = deriveConnectionTruth(statusFor(auditStore, 'data', 'peer'), NOW);
		expect(truth.connected).to.equal(false);
		expect(truth.lastLiveness).to.equal(0);
		expect(truth.errorCode).to.equal(undefined);
		expect(readFireCounters(statusFor(auditStore, 'data', 'peer'))).to.equal(undefined);
	});

	it('leaves a different peer on the same database untouched', () => {
		const auditStore = makeAuditStore();
		for (const peer of ['gone', 'kept'])
			seed(auditStore, 'data', peer)[CONNECTION_STATE_POSITION] = CONNECTION_STATE_CONNECTED;

		clearReplicationSharedStatus(auditStore, 'data', 'gone');

		expect(statusFor(auditStore, 'data', 'gone')[CONNECTION_STATE_POSITION]).to.equal(0);
		expect(statusFor(auditStore, 'data', 'kept')[CONNECTION_STATE_POSITION]).to.equal(CONNECTION_STATE_CONNECTED);
	});

	it('refuses an incomplete key rather than resolving a wrong buffer', () => {
		const auditStore = makeAuditStore();
		expect(clearReplicationSharedStatus(auditStore, 'data', undefined)).to.equal(false);
		expect(clearReplicationSharedStatus(auditStore, undefined, 'peer')).to.equal(false);
		expect(clearReplicationSharedStatus(undefined, 'data', 'peer')).to.equal(false);
		expect(auditStore.buffers.size).to.equal(0);
	});
});
