/**
 * selectSubscriptionNodes decides which nodes a subscribe-to-node request actually subscribes to.
 * The worker re-checks shouldReplicateFromNode, but that predicate reads thread-local state
 * (loaded databases, this node's own hdb_nodes record) that lags the main thread at startup. If the
 * re-check empties a non-empty request, sending an empty subscription arms a permanent
 * "no subscriptions" close — so we trust the main thread's decision in that case. A genuinely empty
 * request (real unsubscribe) must still pass through empty. See harper-pro#289 / #233.
 */

import { expect } from 'chai';
import { selectSubscriptionNodes } from '#src/replication/replicator';

const node = (name, desired) => ({ name, desired });
const isDesired = (n) => !!n.desired;

describe('selectSubscriptionNodes', () => {
	it('keeps only the desired nodes when the re-check agrees (normal winnowing)', () => {
		const nodes = [node('a', true), node('b', false), node('c', true)];
		expect(selectSubscriptionNodes(nodes, isDesired)).to.deep.equal([node('a', true), node('c', true)]);
	});

	it('passes a genuinely empty request through as empty (real unsubscribe)', () => {
		expect(selectSubscriptionNodes([], isDesired)).to.deep.equal([]);
	});

	it('trusts the main thread when the re-check would empty a non-empty request (startup state lag)', () => {
		// Main dispatched a node to subscribe to, but this worker's lagging local state filters it out.
		// Returning [] here would arm the permanent "no subscriptions" close — instead keep the request.
		const nodes = [node('a', false), node('b', false)];
		expect(selectSubscriptionNodes(nodes, isDesired)).to.deep.equal(nodes);
	});

	it('returns the filtered subset unchanged when at least one node is desired', () => {
		const nodes = [node('a', true), node('b', false)];
		expect(selectSubscriptionNodes(nodes, isDesired)).to.deep.equal([node('a', true)]);
	});
});
