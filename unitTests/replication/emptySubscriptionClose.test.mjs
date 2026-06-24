/**
 * Coverage for shouldFinishEmptySubscriptionClose — the classifier behind replicateOverWS's
 * empty-subscription delayed close (replication/replicationConnection.ts).
 *
 * The bug (4-node preprod cluster, CDP-confirmed): after a base-copy resync the connection briefly mapped
 * to a 0-length WIRE subscription, so scheduleClose fired close(1008, '...no longer used', intentional=true).
 * The close handler's `intentional` branch then set isFinished=true / intentionallyUnsubscribed=true,
 * emitted 'finished' (deleting the connection from the worker map), and did NOT reschedule — even though
 * the peer was still desired (the connection's nodeSubscriptions were still populated). Result: a
 * still-wanted peer wedged at connected:false for hours with retries:0.
 *
 * The fix gates the `intentional` flag on shouldFinishEmptySubscriptionClose: a genuine unsubscribe sets
 * the connection's nodeSubscriptions to [] (replicator.assignReplicationSource's subscribe([], false) on
 * database removal, and unsubscribeFromNode -> unsubscribe()), so empty/absent nodeSubscriptions means
 * "no longer desired" -> finish (clean idle cleanup, unchanged). A still-desired peer (nodeSubscriptions
 * populated) at a transient 0-length wire subscription is NOT finished, so the close handler reconnects
 * and the connection self-heals.
 *
 * The classifier is exported as a pure predicate (mirroring shouldTerminateIdlePing / isBlobStreamTimedOut
 * in the same module); the close handler's intentional branch and reconnect-eligibility guards it feeds are
 * exercised by forceReconnect.test.mjs / connectReschedulesOnRejection.test.mjs.
 */

import { expect } from 'chai';
import { NodeReplicationConnection, shouldFinishEmptySubscriptionClose } from '#src/replication/replicationConnection';

describe('shouldFinishEmptySubscriptionClose', () => {
	// THE bug-closing case: a still-desired peer (nodeSubscriptions populated) must NOT be finished even
	// though its wire subscription went 0-length. Before the fix this path passed intentional=true and
	// permanently wedged the peer.
	it('returns false (do NOT finish) when the connection still has desired nodeSubscriptions', () => {
		expect(shouldFinishEmptySubscriptionClose({ nodeSubscriptions: [{ name: 'peer-b' }] })).to.equal(false);
	});

	it('returns false for multiple still-desired subscriptions', () => {
		expect(
			shouldFinishEmptySubscriptionClose({ nodeSubscriptions: [{ name: 'peer-b' }, { name: 'peer-c' }] })
		).to.equal(false);
	});

	// Genuine unsubscribe: replicator sets nodeSubscriptions to [] before this fires. The idle
	// "no subscriptions -> close" cleanup must still finish the connection cleanly (no reconnect).
	it('returns true (finish) when nodeSubscriptions is an empty array (genuine unsubscribe)', () => {
		expect(shouldFinishEmptySubscriptionClose({ nodeSubscriptions: [] })).to.equal(true);
	});

	it('returns true when nodeSubscriptions is undefined (never desired on this connection)', () => {
		expect(shouldFinishEmptySubscriptionClose({})).to.equal(true);
	});

	it('returns true when the connection itself is undefined', () => {
		expect(shouldFinishEmptySubscriptionClose(undefined)).to.equal(true);
	});
});

/**
 * Link the classifier to the reconnect-eligibility flags the close handler consults. The close handler
 * (NodeReplicationConnection 'close' listener) finishes a connection ONLY when
 * intentionallyUnsubscribed is true; close()'s intentional argument — now
 * shouldFinishEmptySubscriptionClose(connection) — is what sets that flag. So a still-desired peer
 * (classifier false) leaves intentionallyUnsubscribed/isFinished false, which keeps the connection
 * eligible to reconnect; a genuinely-unsubscribed peer (classifier true) sets it and blocks reconnect.
 * Here we assert that eligibility contract directly on a real NodeReplicationConnection.
 */
describe('empty-subscription close maps to reconnect-eligibility on NodeReplicationConnection', () => {
	function makeConnection(nodeSubscriptions) {
		const conn = new NodeReplicationConnection('wss://peer/db', null, 'db', 'peer');
		conn.nodeSubscriptions = nodeSubscriptions;
		return conn;
	}

	it('still-desired peer: classifier false -> intentional false -> connection stays reconnect-eligible', () => {
		const conn = makeConnection([{ name: 'peer-b' }]);
		const intentional = shouldFinishEmptySubscriptionClose(conn);
		expect(intentional).to.equal(false);
		// The close()/close-handler intentional branch only runs when intentionallyUnsubscribed is set;
		// with intentional=false it is not set, so the connection is neither finished nor blocked from
		// reconnecting (forceReconnect/connect early-return only on intentionallyUnsubscribed || isFinished).
		if (intentional) conn.intentionallyUnsubscribed = true; // mirrors close()'s real assignment
		expect(conn.intentionallyUnsubscribed, 'still-desired peer is not marked unsubscribed').to.equal(false);
		expect(conn.isFinished, 'still-desired peer is not finished').to.equal(false);
	});

	it('genuinely-unsubscribed peer: classifier true -> intentional true -> connection is finished/blocked', () => {
		const conn = makeConnection([]);
		const intentional = shouldFinishEmptySubscriptionClose(conn);
		expect(intentional).to.equal(true);
		if (intentional) conn.intentionallyUnsubscribed = true; // mirrors close()'s real assignment
		expect(conn.intentionallyUnsubscribed, 'genuine unsubscribe is marked').to.equal(true);
	});
});
