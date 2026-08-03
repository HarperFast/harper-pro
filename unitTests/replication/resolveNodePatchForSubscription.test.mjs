/**
 * Regression coverage for hdb_nodes patch-driven subscription refreshes.
 *
 * remove_node_back deletes a full-replication node's self row. Rejoining through add_node_back
 * recreates that row with patch(), whose change event contains a replicates field but is not a full
 * record. The watcher previously forwarded only isLeader patches, leaving the subscription manager
 * stuck in its replication-off state even though the restored self row said replicates:true.
 */

import { expect } from 'chai';
import { resolveNodePatchForSubscription } from '#src/replication/knownNodes';

function storeWith(records) {
	return {
		getSync(id) {
			return records[id];
		},
	};
}

describe('resolveNodePatchForSubscription', () => {
	it('resolves a replicates patch to the complete self row', () => {
		const row = {
			name: 'node-b',
			url: 'ws://node-b:9933',
			replicates: true,
			subscriptions: null,
		};

		expect(
			resolveNodePatchForSubscription(
				{ type: 'patch', id: 'node-b', value: { name: 'node-b', replicates: true } },
				storeWith({ 'node-b': row })
			)
		).to.equal(row);
	});

	it('resolves peer patches generically rather than special-casing isLeader', () => {
		const row = { name: 'node-a', url: 'ws://node-a:9933', replicates: true };

		expect(
			resolveNodePatchForSubscription(
				{ type: 'patch', id: 'node-a', value: { name: 'node-a', url: 'ws://node-a:9933' } },
				storeWith({ 'node-a': row })
			)
		).to.equal(row);
	});

	it('ignores non-patch events and invalid decoded rows', () => {
		const store = storeWith({ 'node-b': [] });

		expect(resolveNodePatchForSubscription({ type: 'put', id: 'node-b' }, store)).to.equal(undefined);
		expect(resolveNodePatchForSubscription({ type: 'patch', id: 'node-b' }, store)).to.equal(undefined);
	});

	it('ignores a transient synchronous read failure', () => {
		const store = {
			getSync() {
				throw new Error('transient decode failure');
			},
		};

		expect(resolveNodePatchForSubscription({ type: 'patch', id: 'node-b' }, store)).to.equal(undefined);
	});
});
