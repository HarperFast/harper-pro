/**
 * Retiring a connection's claim on the (database, peer) shared status when its node leaves the cluster.
 *
 * `unsubscribe()` only starts the teardown. Until the socket closes the session keeps writing: the close
 * handler stamps DOWN + close code 1008, and a frame or pong on the still-closing socket re-stamps CONNECTED
 * and fresh liveness. All of those are gated on `nodeSubscriptions !== undefined`, which unsubscribing never
 * cleared, so they landed after the main thread had zeroed the buffer and a same-process re-add inherited
 * them. The invariant: after the release, no owner-class write from the departing connection passes its gate.
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
	it('drops the owner marker every shared-status write is gated on', () => {
		const { connection } = departingConnection();
		releaseSharedStatusOnUnsubscribe(connection);
		expect(connection.nodeSubscriptions).to.equal(undefined);
		expect(connection.sharedStatus).to.equal(undefined);
	});

	it('a late CONNECTED write cannot revive the removed membership', () => {
		const { connection, shared } = departingConnection();
		releaseSharedStatusOnUnsubscribe(connection);
		// The main thread has zeroed the buffer; a pong then arrives on the still-closing socket. This is the
		// gate every CONNECTED writer applies (pong, received data, handshake).
		if (connection.nodeSubscriptions !== undefined) {
			shared[CONNECTION_STATE_POSITION] = CONNECTION_STATE_CONNECTED;
			shared[LAST_LIVENESS_TIME_POSITION] = NOW;
		}
		expect(deriveConnectionTruth(shared, NOW).connected).to.equal(false);
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
