/**
 * selectSubscriptionNodes decides which nodes a subscribe-to-node request actually subscribes to.
 * The worker re-checks shouldReplicateFromNode, but that predicate reads thread-local state (loaded
 * databases, this node's own hdb_nodes record) that lags the main thread at startup. If the re-check
 * empties a non-empty request *while local state isn't ready*, sending an empty subscription arms a
 * permanent "no subscriptions" close — so we trust the main thread in that case. Once state IS ready,
 * the re-check is respected so a genuinely disabled/removed node (a stale request) is left
 * unsubscribed. A genuinely empty request (real unsubscribe) always passes through empty.
 * See harper-pro#289 / #233.
 */

import { expect } from 'chai';
import { selectSubscriptionNodes } from '#src/replication/replicator';

const node = (name, desired) => ({ name, desired });
const isDesired = (n) => !!n.desired;

describe('selectSubscriptionNodes', () => {
	it('keeps only the desired nodes when the re-check agrees (normal winnowing)', () => {
		const nodes = [node('a', true), node('b', false), node('c', true)];
		expect(selectSubscriptionNodes(nodes, isDesired, true)).to.deep.equal([node('a', true), node('c', true)]);
	});

	it('passes a genuinely empty request through as empty (real unsubscribe), regardless of readiness', () => {
		expect(selectSubscriptionNodes([], isDesired, true)).to.deep.equal([]);
		expect(selectSubscriptionNodes([], isDesired, false)).to.deep.equal([]);
	});

	it('trusts the main thread when the re-check empties a non-empty request AND state is not ready (startup race)', () => {
		const nodes = [node('a', false), node('b', false)];
		expect(selectSubscriptionNodes(nodes, isDesired, false)).to.deep.equal(nodes);
	});

	it('respects an empty re-check once state is ready (genuinely disabled/removed — no spurious re-subscribe)', () => {
		// Main dispatched these nodes, but by the time the worker processed it the node was disabled/removed;
		// with state loaded the re-check is authoritative, so we must NOT re-create the subscription.
		const nodes = [node('a', false), node('b', false)];
		expect(selectSubscriptionNodes(nodes, isDesired, true)).to.deep.equal([]);
	});

	it('returns the filtered subset when at least one node is desired (readiness irrelevant)', () => {
		const nodes = [node('a', true), node('b', false)];
		expect(selectSubscriptionNodes(nodes, isDesired, false)).to.deep.equal([node('a', true)]);
	});
});
