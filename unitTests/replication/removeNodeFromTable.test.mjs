import assert from 'node:assert';
import { removeNodeFromTable, findExistingNodeRecord } from '#src/replication/setNode';
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
const drainedNothing = async () => ({ databases: {} });
const drained = { drain: drainedNothing };

describe('removeNodeFromTable', () => {
	it('resolves the address a peer was added by to the row stored under its reported name', async () => {
		const table = nodeTable([{ name: 'peer-b', url: PEER_URL, replicates: true }]);
		const send = recordingTransport();

		const message = await removeNodeFromTable('10.0.0.2', PEER_URL, table, send, drained);

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

		const message = await removeNodeFromTable('10.0.0.2', PEER_URL, table, send, drained);

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

		await removeNodeFromTable('10.0.0.2', PEER_URL, table, send, drained);

		assert.equal(send.sent[0].operation.name, getThisNodeName());
	});

	it('bounds the reciprocal with a deadline', async () => {
		const table = nodeTable([{ name: 'peer-b', url: PEER_URL, replicates: true }]);
		const send = recordingTransport();

		await removeNodeFromTable('peer-b', PEER_URL, table, send, drained);

		assert.ok(Number.isFinite(send.sent[0].options?.timeoutMs) && send.sent[0].options.timeoutMs > 0);
	});

	it('reports a reciprocal the peer did not confirm, keeping the local removal', async () => {
		const table = nodeTable([{ name: 'peer-b', url: PEER_URL, replicates: true }]);
		const send = recordingTransport(async () => {
			throw new Error(`remove_node_back may only remove the authenticated peer or this node, not '10.0.0.2'`);
		});

		const message = await removeNodeFromTable('peer-b', PEER_URL, table, send, drained);

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

		await assert.rejects(removeNodeFromTable('10.0.0.2', PEER_URL, table, neverSend, drained), (error) => {
			assert.match(error.message, /matches more than one registered node \(peer-b-old, peer-b\)/);
			assert.equal(error.statusCode, 400);
			return true;
		});
		assert.deepEqual(table.deleted, []);
	});

	it("does not resolve an address to this node's own row", async () => {
		const table = nodeTable([{ name: getThisNodeName(), url: PEER_URL, replicates: true }]);

		await assert.rejects(
			removeNodeFromTable('10.0.0.2', PEER_URL, table, neverSend, drained),
			/10\.0\.0\.2 does not exist/
		);
		assert.deepEqual(table.deleted, []);
	});

	it('does not match a row without a url when no url could be derived', async () => {
		const table = nodeTable([{ name: 'peer-b', replicates: true }]);

		await assert.rejects(
			removeNodeFromTable('10.0.0.2', undefined, table, neverSend, drained),
			/10\.0\.0\.2 does not exist/
		);
		assert.equal(table.scans, 0);
		assert.deepEqual(table.deleted, []);
	});

	it('rejects an unknown node without sending anything', async () => {
		const table = nodeTable([{ name: 'peer-c', url: 'ws://10.0.0.3:9933', replicates: true }]);

		await assert.rejects(
			removeNodeFromTable('10.0.0.2', PEER_URL, table, neverSend, drained),
			/10\.0\.0\.2 does not exist/
		);
	});

	it('fails without notifying the peer when the local delete fails', async () => {
		const table = nodeTable([{ name: 'peer-b', url: PEER_URL, replicates: true }]);
		table.delete = async () => {
			throw new Error('storage unavailable');
		};

		await assert.rejects(removeNodeFromTable('peer-b', PEER_URL, table, neverSend, drained), /storage unavailable/);
	});
});

describe('removeNodeFromTable draining (harper-pro#1348)', () => {
	it('drains the node before deleting its row, with the requested budget', async () => {
		const table = nodeTable([{ name: 'peer-b', url: PEER_URL, replicates: true }]);
		const calls = [];
		const drain = async (name, record, timeoutMs) => {
			calls.push({ name, timeoutMs, deletedYet: table.deleted.length });
			return { databases: { data: { peers: ['a', 'c'] }, other: { peers: ['a'] } } };
		};
		const message = await removeNodeFromTable('peer-b', PEER_URL, table, recordingTransport(), {
			drain,
			timeout: 1234,
		});
		assert.deepEqual(calls, [{ name: 'peer-b', timeoutMs: 1234, deletedYet: 0 }]);
		assert.deepEqual(table.deleted, ['peer-b']);
		assert.match(message, /its writes reached 2 peers before it was removed$/);
	});

	it('keeps the row when the drain fails', async () => {
		const table = nodeTable([{ name: 'peer-b', url: PEER_URL, replicates: true }]);
		const drain = async () => {
			throw Object.assign(new Error('Timed out after 5ms waiting'), { statusCode: 504 });
		};
		await assert.rejects(removeNodeFromTable('peer-b', PEER_URL, table, neverSend, { drain }), /Timed out/);
		assert.deepEqual(table.deleted, []);
	});

	it('skips the drain with force and says writes may be lost', async () => {
		const table = nodeTable([{ name: 'peer-b', url: PEER_URL, replicates: true }]);
		const drain = () => assert.fail('force must not drain');
		const message = await removeNodeFromTable('peer-b', PEER_URL, table, recordingTransport(), { drain, force: true });
		assert.deepEqual(table.deleted, ['peer-b']);
		assert.match(
			message,
			/removed without waiting for its writes to reach its peers, so writes only it held may be lost$/
		);
	});

	it('cancels on the node itself without deleting anything', async () => {
		const table = nodeTable([{ name: 'peer-b', url: PEER_URL, replicates: true }]);
		const send = recordingTransport();
		const message = await removeNodeFromTable('peer-b', PEER_URL, table, send, { cancel: true });
		assert.deepEqual(table.deleted, []);
		assert.deepEqual(send.sent[0].operation, { operation: 'remove_node_fence', node: 'peer-b', cancel: true });
		assert.match(message, /^Cancelled the removal of 'peer-b'/);
	});

	it('refuses an invalid budget before draining or deleting', async () => {
		const table = nodeTable([{ name: 'peer-b', url: PEER_URL, replicates: true }]);
		for (const timeout of [0, -1, 1.5, 'soon'])
			await assert.rejects(
				removeNodeFromTable('peer-b', PEER_URL, table, neverSend, { drain: drainedNothing, timeout }),
				/timeout must be an integer/
			);
		assert.deepEqual(table.deleted, []);
	});
});

describe('findExistingNodeRecord', () => {
	it("resolves an address to this node's own row, so update_node patches it rather than re-adding it", async () => {
		const self = { name: getThisNodeName(), url: PEER_URL, replicates: { sendsTo: [{ database: 'data' }] } };
		const table = nodeTable([self]);

		assert.deepEqual(await findExistingNodeRecord('10.0.0.2', PEER_URL, table), { name: self.name, record: self });
	});
});
