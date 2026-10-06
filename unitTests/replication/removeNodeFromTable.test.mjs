import assert from 'node:assert';
import { removeNodeFromTable } from '#src/replication/setNode';
import { getThisNodeName } from '#src/core/server/nodeName';

const PEER_URL = 'ws://10.0.0.2:9933';

function nodeTable(rows) {
	const store = new Map(rows.map((row) => [row.name, row]));
	const deleted = [];
	let scans = 0;
	return {
		deleted,
		get scans() {
			return scans;
		},
		get: async (name) => store.get(name),
		delete: async (name) => {
			deleted.push(name);
			store.delete(name);
		},
		search: () => {
			scans++;
			return [...store.values()];
		},
	};
}

function recordingTransport(outcome = async () => ({})) {
	const sent = [];
	const send = (node, operation, options) => {
		sent.push({ node, operation, options });
		return outcome();
	};
	send.sent = sent;
	return send;
}

const neverSend = () => assert.fail('no reciprocal operation may be sent');

describe('removeNodeFromTable', () => {
	it('resolves the address a peer was added by to the row stored under its reported name', async () => {
		const table = nodeTable([{ name: 'peer-b', url: PEER_URL, replicates: true }]);
		const send = recordingTransport();

		const message = await removeNodeFromTable('10.0.0.2', PEER_URL, table, send);

		assert.deepEqual(table.deleted, ['peer-b']);
		assert.equal(send.sent.length, 1);
		assert.equal(send.sent[0].node.name, 'peer-b');
		assert.deepEqual(send.sent[0].operation, { operation: 'remove_node_back', name: 'peer-b' });
		assert.equal(message, `Successfully removed 'peer-b' from cluster`);
	});

	it('removes a direct key match and reports other rows still registered at its url', async () => {
		const table = nodeTable([
			{ name: '10.0.0.2', url: PEER_URL, replicates: true },
			{ name: 'peer-b', url: PEER_URL, replicates: true },
		]);
		const send = recordingTransport();

		const message = await removeNodeFromTable('10.0.0.2', PEER_URL, table, send);

		assert.deepEqual(table.deleted, ['10.0.0.2']);
		assert.equal(send.sent[0].operation.name, '10.0.0.2');
		assert.equal(
			message,
			`Successfully removed '10.0.0.2' from cluster; still registered at ${PEER_URL} and not removed: 'peer-b'`
		);
	});

	it('names this node in the reciprocal when the peer has explicit subscriptions', async () => {
		const table = nodeTable([{ name: 'peer-b', url: PEER_URL, subscriptions: [{ database: 'data' }] }]);
		const send = recordingTransport();

		await removeNodeFromTable('10.0.0.2', PEER_URL, table, send);

		assert.equal(send.sent[0].operation.name, getThisNodeName());
	});

	it('bounds the reciprocal with a deadline', async () => {
		const table = nodeTable([{ name: 'peer-b', url: PEER_URL, replicates: true }]);
		const send = recordingTransport();

		await removeNodeFromTable('peer-b', PEER_URL, table, send);

		assert.ok(Number.isFinite(send.sent[0].options?.timeoutMs) && send.sent[0].options.timeoutMs > 0);
	});

	it('reports a reciprocal the peer did not confirm, keeping the local removal', async () => {
		const table = nodeTable([{ name: 'peer-b', url: PEER_URL, replicates: true }]);
		const send = recordingTransport(async () => {
			throw new Error(`remove_node_back may only remove the authenticated peer or this node, not '10.0.0.2'`);
		});

		const message = await removeNodeFromTable('peer-b', PEER_URL, table, send);

		assert.deepEqual(table.deleted, ['peer-b']);
		assert.match(
			message,
			/^Successfully removed 'peer-b' from cluster but removal on the target node was not confirmed: /
		);
		assert.match(message, /may only remove the authenticated peer/);
	});

	it('refuses an address that matches more than one row, before deleting or sending', async () => {
		const table = nodeTable([
			{ name: 'peer-b-old', url: PEER_URL, replicates: true },
			{ name: 'peer-b', url: PEER_URL, replicates: true },
		]);

		await assert.rejects(removeNodeFromTable('10.0.0.2', PEER_URL, table, neverSend), (error) => {
			assert.match(error.message, /matches more than one registered node \(peer-b-old, peer-b\)/);
			assert.equal(error.statusCode, 400);
			return true;
		});
		assert.deepEqual(table.deleted, []);
	});

	it("does not resolve an address to this node's own row", async () => {
		const table = nodeTable([{ name: getThisNodeName(), url: PEER_URL, replicates: true }]);

		await assert.rejects(removeNodeFromTable('10.0.0.2', PEER_URL, table, neverSend), /10\.0\.0\.2 does not exist/);
		assert.deepEqual(table.deleted, []);
	});

	it('does not match a row without a url when no url could be derived', async () => {
		const table = nodeTable([{ name: 'peer-b', replicates: true }]);

		await assert.rejects(removeNodeFromTable('10.0.0.2', undefined, table, neverSend), /10\.0\.0\.2 does not exist/);
		assert.equal(table.scans, 0);
		assert.deepEqual(table.deleted, []);
	});

	it('rejects an unknown node without sending anything', async () => {
		const table = nodeTable([{ name: 'peer-c', url: 'ws://10.0.0.3:9933', replicates: true }]);

		await assert.rejects(removeNodeFromTable('10.0.0.2', PEER_URL, table, neverSend), /10\.0\.0\.2 does not exist/);
	});

	it('fails without notifying the peer when the local delete fails', async () => {
		const table = nodeTable([{ name: 'peer-b', url: PEER_URL, replicates: true }]);
		table.delete = async () => {
			throw new Error('storage unavailable');
		};

		await assert.rejects(removeNodeFromTable('peer-b', PEER_URL, table, neverSend), /storage unavailable/);
	});
});
