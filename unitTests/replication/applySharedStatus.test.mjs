/**
 * `cluster_status` reads each link's shared-status slots through applySharedStatus. The `'Copying'`
 * sentinel belongs to the sending-time slot only: the copy sender writes SENDING_TIME_COPYING there, and
 * every other date slot holds an epoch-ms value, so a 1 in one of them formats as a date.
 */
import { expect } from 'chai';
import { applySharedStatus } from '#src/replication/clusterStatus';
import {
	CONFIRMATION_STATUS_POSITION,
	RECEIVED_VERSION_POSITION,
	RECEIVED_TIME_POSITION,
	SENDING_TIME_POSITION,
	SENDING_TIME_COPYING,
	LAST_BLOB_FAILURE_TIME_POSITION,
} from '#src/replication/replicationConnection';
import { REPLICATION_SHARED_STATUS_SLOTS } from '#src/replication/knownNodes';

const NOW = 1_700_000_000_000;
const newStatus = () => new Float64Array(REPLICATION_SHARED_STATUS_SLOTS);
const apply = (status) => {
	const socket = {};
	applySharedStatus(socket, status);
	return socket;
};

describe('applySharedStatus', () => {
	it('reports a sending copy as Copying', () => {
		const status = newStatus();
		status[SENDING_TIME_POSITION] = SENDING_TIME_COPYING;
		expect(apply(status).sendingMessage).to.equal('Copying');
	});

	it('formats a live sending time as a UTC date', () => {
		const status = newStatus();
		status[SENDING_TIME_POSITION] = NOW;
		expect(apply(status).sendingMessage).to.equal(new Date(NOW).toUTCString());
	});

	it('omits the sending time when nothing is being sent', () => {
		expect(apply(newStatus()).sendingMessage).to.equal(undefined);
	});

	it('formats a 1 in any other date slot as a date, never as Copying', () => {
		const status = newStatus();
		for (const position of [
			CONFIRMATION_STATUS_POSITION,
			RECEIVED_VERSION_POSITION,
			RECEIVED_TIME_POSITION,
			LAST_BLOB_FAILURE_TIME_POSITION,
		]) {
			status[position] = 1;
		}
		const socket = apply(status);
		const epochPlusOne = new Date(1).toUTCString();
		expect(socket.lastCommitConfirmed).to.equal(epochPlusOne);
		expect(socket.lastReceivedRemoteTime).to.equal(epochPlusOne);
		expect(socket.lastReceivedLocalTime).to.equal(epochPlusOne);
		expect(socket.lastBlobFailure).to.equal(epochPlusOne);
		expect(socket.sendingMessage).to.equal(undefined);
	});
});
