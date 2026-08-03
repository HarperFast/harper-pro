import { rejects } from 'node:assert/strict';
import { removeNodeBack } from '#src/replication/setNode';

describe('removeNodeBack authorization', () => {
	it('rejects a target other than the authenticated peer or this node', async () => {
		await rejects(
			removeNodeBack({
				name: 'unrelated-node',
				hdb_user: { name: 'authenticated-peer' },
			}),
			/remove_node_back may only remove the authenticated peer or this node/
		);
	});

	it('rejects a request without an authenticated peer identity', async () => {
		await rejects(
			removeNodeBack({ name: 'unrelated-node' }),
			/remove_node_back may only remove the authenticated peer or this node/
		);
	});
});
