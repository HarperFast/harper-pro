/**
 * Regression coverage for harper-pro#328: when a failed-over node reconnects, the restore flow
 * must tear down the failover subscription the old worker is still holding. Two silent failures
 * are pinned here:
 *
 *   1) The posted message type must be 'unsubscribe-from-node' — the previously posted
 *      'unsubscribe-to-node' had no registered handler, so the worker dropped the message and
 *      kept a phantom subscription.
 *   2) The `url` must be the failover entry's own url (the subscribe-time connectingUrl), not the
 *      restored node's url. The worker registers the connection under
 *      `connectingUrl + '-' + node.url` (replicator.getSubscriptionConnection), so an unsubscribe
 *      keyed by the restored node's url never matches and the teardown is a no-op even with the
 *      correct type.
 *
 * Also covers the single-threaded fallback (no worker assigned: unsubscribe directly on this
 * thread, mirroring the subscribe/unsubscribe fallbacks elsewhere in subscriptionManager).
 */

import { expect } from 'chai';
import { removeRestoredNodeFromFailoverEntry } from '#src/replication/subscriptionManager';

const ENTRY_URL = 'wss://failover-node:9933';
const RESTORED_URL = 'wss://restored-node:9933';

function makeWorker() {
	const messages = [];
	return { messages, postMessage: (message) => messages.push(message) };
}

function makeNode(name, worker, url = `wss://${name}:9933`) {
	const node = { name, url };
	// production assigns worker via a non-enumerable defineProperty; a plain property is equivalent here
	if (worker) node.worker = worker;
	return node;
}

describe('removeRestoredNodeFromFailoverEntry', () => {
	it('posts unsubscribe-from-node with the entry url (not the restored node url) and prunes the node', () => {
		const worker = makeWorker();
		const restoredNode = { name: 'restored-node', url: RESTORED_URL };
		const failedOver = makeNode('restored-node', worker, RESTORED_URL);
		const own = makeNode('failover-node', makeWorker(), ENTRY_URL);
		const entry = { url: ENTRY_URL, nodes: [own, failedOver] };

		removeRestoredNodeFromFailoverEntry(entry, restoredNode, 'data');

		expect(worker.messages).to.have.lengthOf(1);
		expect(worker.messages[0]).to.deep.equal({
			type: 'unsubscribe-from-node',
			database: 'data',
			url: ENTRY_URL,
			nodes: [failedOver],
		});
		expect(worker.messages[0].url).to.not.equal(RESTORED_URL);
		expect(entry.nodes).to.deep.equal([own]);
	});

	it('does not post to workers of non-matching nodes', () => {
		const ownWorker = makeWorker();
		const otherWorker = makeWorker();
		const own = makeNode('failover-node', ownWorker, ENTRY_URL);
		const other = makeNode('other-node', otherWorker);
		const matching = makeNode('restored-node', makeWorker(), RESTORED_URL);
		const entry = { url: ENTRY_URL, nodes: [own, other, matching] };

		removeRestoredNodeFromFailoverEntry(entry, { name: 'restored-node' }, 'data');

		expect(ownWorker.messages).to.be.empty;
		expect(otherWorker.messages).to.be.empty;
		expect(entry.nodes).to.deep.equal([own, other]);
	});

	it('leaves the nodes array untouched when nothing matches', () => {
		const own = makeNode('failover-node', makeWorker(), ENTRY_URL);
		const other = makeNode('other-node', makeWorker());
		const nodes = [own, other];
		const entry = { url: ENTRY_URL, nodes };

		removeRestoredNodeFromFailoverEntry(entry, { name: 'restored-node' }, 'data');

		expect(entry.nodes).to.equal(nodes); // same reference, not reassigned
		expect(entry.nodes).to.deep.equal([own, other]);
	});

	it('unsubscribes directly on this thread when the matching node has no worker', () => {
		const unsubscribed = [];
		const matching = makeNode('restored-node', undefined, RESTORED_URL);
		const own = makeNode('failover-node', makeWorker(), ENTRY_URL);
		const entry = { url: ENTRY_URL, nodes: [own, matching] };

		removeRestoredNodeFromFailoverEntry(entry, { name: 'restored-node' }, 'data', (request) =>
			unsubscribed.push(request)
		);

		expect(unsubscribed).to.have.lengthOf(1);
		expect(unsubscribed[0]).to.deep.equal({
			type: 'unsubscribe-from-node',
			database: 'data',
			url: ENTRY_URL,
			nodes: [matching],
		});
		expect(entry.nodes).to.deep.equal([own]);
	});

	it('tears down every matching node on its own worker', () => {
		const workerA = makeWorker();
		const workerB = makeWorker();
		const matchingA = makeNode('restored-node', workerA, RESTORED_URL);
		const matchingB = makeNode('restored-node', workerB, RESTORED_URL);
		const own = makeNode('failover-node', makeWorker(), ENTRY_URL);
		const entry = { url: ENTRY_URL, nodes: [own, matchingA, matchingB] };

		removeRestoredNodeFromFailoverEntry(entry, { name: 'restored-node' }, 'data');

		expect(workerA.messages).to.have.lengthOf(1);
		expect(workerB.messages).to.have.lengthOf(1);
		expect(entry.nodes).to.deep.equal([own]);
	});

	it('drops falsy placeholder entries, preserving the previous filter semantics', () => {
		const own = makeNode('failover-node', makeWorker(), ENTRY_URL);
		const entry = { url: ENTRY_URL, nodes: [own, undefined, null] };

		removeRestoredNodeFromFailoverEntry(entry, { name: 'restored-node' }, 'data');

		expect(entry.nodes).to.deep.equal([own]);
	});
});
