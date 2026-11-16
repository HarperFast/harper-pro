import assert from 'node:assert';
import { removeNodeBackFromTable } from '#src/replication/setNode';
import { getThisNodeName } from '#src/core/server/nodeName';

function nodeTable(names) {
	const rows = new Set(names);
	return {
		deleted: [],
		delete: async function (name) {
			this.deleted.push(name);
			rows.delete(name);
		},
		search: () => [...rows].map((name) => ({ name })),
	};
}

function recordingLift() {
	const calls = [];
	const lift = async (removed) => {
		calls.push(removed);
	};
	lift.calls = calls;
	return lift;
}

describe('removeNodeBack authorization', () => {
	const neverDelete = {
		delete: () => assert.fail('unauthorized request must not delete any node row'),
	};

	it('allows the authenticated peer to remove its own record', async () => {
		const table = nodeTable(['authenticated-peer']);
		await removeNodeBackFromTable(
			{ name: 'authenticated-peer', hdb_user: { name: 'authenticated-peer' } },
			table,
			recordingLift()
		);
		assert.deepEqual(table.deleted, ['authenticated-peer']);
	});

	it('rejects a target other than the authenticated peer or this node', async () => {
		await assert.rejects(
			removeNodeBackFromTable(
				{
					name: 'unrelated-node',
					hdb_user: { name: 'authenticated-peer' },
				},
				neverDelete
			),
			/remove_node_back may only remove the authenticated peer or this node/
		);
	});

	it('rejects a request without an authenticated peer identity', async () => {
		await assert.rejects(
			removeNodeBackFromTable({ name: 'unrelated-node' }, neverDelete),
			/remove_node_back may only remove the authenticated peer or this node/
		);
	});
});

describe('removeNodeBack lifting the fence (harper-pro#1348)', () => {
	it('keeps a finalized fence when it deletes one peer while this node still holds others', async () => {
		const lift = recordingLift();
		const table = nodeTable([getThisNodeName(), 'peer-a', 'peer-b']);
		await removeNodeBackFromTable({ name: 'peer-a', hdb_user: { name: 'peer-a' } }, table, lift);
		assert.deepEqual(table.deleted, ['peer-a']);
		assert.deepEqual(lift.calls, [false]);
	});

	it('lifts it when it deletes the last peer this node holds', async () => {
		const lift = recordingLift();
		await removeNodeBackFromTable(
			{ name: 'peer-a', hdb_user: { name: 'peer-a' } },
			nodeTable([getThisNodeName(), 'peer-a']),
			lift
		);
		assert.deepEqual(lift.calls, [true]);
	});

	it("lifts it when the notice removes this node's own row", async () => {
		const lift = recordingLift();
		await removeNodeBackFromTable(
			{ name: getThisNodeName(), hdb_user: { name: 'peer-a' } },
			nodeTable([getThisNodeName(), 'peer-a', 'peer-b']),
			lift
		);
		assert.deepEqual(lift.calls, [true]);
	});
});
