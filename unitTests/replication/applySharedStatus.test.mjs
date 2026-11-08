/**
 * Only the sending-time slot carries the copy sentinel; every other date slot holds epoch ms.
 */
import assert from 'node:assert';
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
import {
	CONNECTION_PATH_POSITION,
	PATH_PRIVATE,
	PATH_PUBLIC,
	PATH_PUBLIC_FALLBACK,
} from '#src/replication/sharedStatusSlots';

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

	it('names the dialed path, and omits it before any handshake', () => {
		const status = newStatus();
		assert.strictEqual(apply(status).path, undefined);
		for (const [value, name] of [
			[PATH_PUBLIC, 'public'],
			[PATH_PRIVATE, 'private'],
			[PATH_PUBLIC_FALLBACK, 'public-fallback'],
		]) {
			status[CONNECTION_PATH_POSITION] = value;
			assert.strictEqual(apply(status).path, name);
		}
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
