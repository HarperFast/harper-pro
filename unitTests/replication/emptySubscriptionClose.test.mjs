/**
 * Coverage for shouldFinishEmptySubscriptionClose — the classifier behind replicateOverWS's
 * empty-subscription delayed close (replication/replicationConnection.ts).
 *
 * The bug (4-node preprod cluster, CDP-confirmed): after a base-copy resync a connection's wire
 * subscription went 0-length, so scheduleClose fired close(1008, '...no longer used', intentional=true).
 * The close handler's `intentional` branch then set isFinished=true / intentionallyUnsubscribed=true,
 * emitted 'finished' (deleting the connection from the worker map), and did NOT reschedule — even though
 * the peer was still desired. Result: a still-wanted peer wedged at connected:false for hours, retries:0.
 *
 * Root-cause subtlety (Codex review): the wire subscription is a 1:1 map of connection.nodeSubscriptions,
 * so at close time that array is itself empty in BOTH the genuine-unsubscribe and the spurious-empty
 * cases — keying on it is a no-op. The only two code paths that drive subscribe([]) are
 * assignReplicationSource on DATABASE REMOVAL (the database is gone — genuinely terminal) and
 * subscribeToNode's nodes.filter(shouldReplicateFromNode) collapsing to [] while the database is still
 * present (spurious, e.g. the #470 self-gate misread for a still-desired peer). So the real discriminator
 * is database presence: finish only when the local database for this connection is gone.
 */

import { expect } from 'chai';
import { shouldFinishEmptySubscriptionClose } from '#src/replication/replicationConnection';

describe('shouldFinishEmptySubscriptionClose', () => {
	// THE bug-closing case: the database is still present, so the empty subscription is spurious (a
	// #470-emptied filter for a still-desired peer). Must NOT finish — the connection self-heals.
	it('returns false (do NOT finish) when the local database is still present', () => {
		expect(shouldFinishEmptySubscriptionClose(true)).to.equal(false);
	});

	// Genuine terminal case: the database was removed (assignReplicationSource's subscribe([], false) on
	// database removal). The idle "no subscriptions -> close" cleanup must still finish the connection.
	it('returns true (finish) when the local database is gone (database removal)', () => {
		expect(shouldFinishEmptySubscriptionClose(false)).to.equal(true);
	});
});
