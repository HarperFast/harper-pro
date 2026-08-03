import assert from 'node:assert';
import { removeNodeBack, removeNodeBackFromTable } from '#src/replication/setNode';

describe('removeNodeBack authorization', () => {
	it('allows the authenticated peer to remove its own record', async () => {
		let deletedName;
		await removeNodeBackFromTable(
			{
				name: 'authenticated-peer',
				hdb_user: { name: 'authenticated-peer' },
			},
			{
				delete: async (name) => {
					deletedName = name;
				},
			}
		);

		assert.equal(deletedName, 'authenticated-peer');
	});

	it('rejects a target other than the authenticated peer or this node', async () => {
		await assert.rejects(
			removeNodeBack({
				name: 'unrelated-node',
				hdb_user: { name: 'authenticated-peer' },
			}),
			/remove_node_back may only remove the authenticated peer or this node/
		);
	});

	it('rejects a request without an authenticated peer identity', async () => {
		await assert.rejects(
			removeNodeBack({ name: 'unrelated-node' }),
			/remove_node_back may only remove the authenticated peer or this node/
		);
	});
});
