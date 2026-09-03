/**
 * Coverage for R2's (harper-pro#431) removal ordering. `unsubscribe()` only starts the teardown: it closes
 * the socket, and the close handler later stamps CONNECTION_STATE_DOWN + close code 1008 + error time through
 * the connection's retained `sharedStatus` view. No CONNECTED writer ever clears the error slots, so on a
 * same-process re-add that stamp lands on the successor's buffer and stays there — cluster_status reports a
 * failure the new link never suffered.
 *
 * The invariant: after the release the departing connection cannot reach the buffer at all, so its close
 * stamps are inert however late they arrive, and the main thread's clear is the last word.
 */

import { expect } from 'chai';
import { releaseSharedStatusOnUnsubscribe } from '#src/replication/replicator';
import {
	CONNECTION_STATE_POSITION,
	LAST_LIVENESS_TIME_POSITION,
	LAST_ERROR_CODE_POSITION,
	LAST_ERROR_TIME_POSITION,
	CONNECTION_STATE_DOWN,
	CONNECTION_STATE_CONNECTED,
	deriveConnectionTruth,
} from '#src/replication/replicationConnection';
import { REPLICATION_SHARED_STATUS_SLOTS } from '#src/replication/knownNodes';

const NOW = 1_700_000_000_000;

// The shape replicateOverWS leaves behind: the connection holds a view of the shared buffer that its close
// handler writes through, gated on `nodeSubscriptions`, which unsubscribing never clears.
function departingConnection() {
	const shared = new Float64Array(REPLICATION_SHARED_STATUS_SLOTS);
	return { connection: { sharedStatus: shared, nodeSubscriptions: [] }, shared };
}

function stampCloseLikeTheCloseHandler(connection, code) {
	if (connection.sharedStatus && connection.nodeSubscriptions !== undefined) {
		connection.sharedStatus[CONNECTION_STATE_POSITION] = CONNECTION_STATE_DOWN;
		connection.sharedStatus[LAST_ERROR_CODE_POSITION] = code;
		connection.sharedStatus[LAST_ERROR_TIME_POSITION] = NOW;
	}
}

describe('releaseSharedStatusOnUnsubscribe', () => {
	it('leaves the close handler with nothing to write through', () => {
		const { connection } = departingConnection();
		releaseSharedStatusOnUnsubscribe(connection);
		expect(connection.sharedStatus).to.equal(undefined);
	});

	it('a late close cannot put a stale 1008 on the membership that replaced it', () => {
		const { connection, shared } = departingConnection();
		releaseSharedStatusOnUnsubscribe(connection);

		// The re-add resolves the SAME buffer and its new link comes up.
		shared[CONNECTION_STATE_POSITION] = CONNECTION_STATE_CONNECTED;
		shared[LAST_LIVENESS_TIME_POSITION] = NOW;
		// Only now does the old socket's close land — minutes later, for the wedged socket this exists for.
		stampCloseLikeTheCloseHandler(connection, 1008);

		const truth = deriveConnectionTruth(shared, NOW);
		expect(truth.connected).to.equal(true);
		expect(truth.errorCode).to.equal(undefined);
	});

	it('does not clear the buffer itself, so a successor on another worker keeps its state', () => {
		// A re-add can be assigned to a different HTTP worker, whose connection this one cannot see. Clearing
		// here as well would erase that successor's CONNECTED stamp; the main thread's own clear, which runs
		// when it drops the node and before any re-add, is what zeroes the departed membership.
		const { connection, shared } = departingConnection();
		shared[CONNECTION_STATE_POSITION] = CONNECTION_STATE_CONNECTED;
		shared[LAST_LIVENESS_TIME_POSITION] = NOW;

		releaseSharedStatusOnUnsubscribe(connection);

		expect(shared[CONNECTION_STATE_POSITION]).to.equal(CONNECTION_STATE_CONNECTED);
		expect(shared[LAST_LIVENESS_TIME_POSITION]).to.equal(NOW);
	});

	it('is a no-op for a connection that never resolved a buffer', () => {
		const connection = { nodeSubscriptions: [] };
		releaseSharedStatusOnUnsubscribe(connection);
		expect(connection.sharedStatus).to.equal(undefined);
	});
});
