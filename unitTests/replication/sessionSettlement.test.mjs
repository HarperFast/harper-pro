/**
 * harper-pro#1189: a read waits on `NodeReplicationConnection.session` (getRecord). Every attempt that
 * fails, and every replacement of that promise, must settle what readers already wait on, and an attempt
 * must settle only its own session.
 */

import assert from 'node:assert';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { NodeReplicationConnection } from '#src/replication/replicationConnection';

const BOUND = 2000;

function settlement(promise) {
	const state = { outcome: 'pending' };
	promise.then(
		() => (state.outcome = 'resolved'),
		(error) => (state.outcome = error)
	);
	return state;
}

async function settled(state, description) {
	const deadline = Date.now() + BOUND;
	while (state.outcome === 'pending') {
		assert.ok(Date.now() < deadline, `${description} did not settle within ${BOUND}ms`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return state.outcome;
}

function withoutRetries(connection) {
	connection.setReconnectTimer = () => ({ unref() {} });
	return connection;
}

describe('NodeReplicationConnection session settlement (harper-pro#1189)', () => {
	it('rejects every read waiting on an attempt whose createWebSocket rejects, with its cause', async () => {
		// a null url makes createWebSocket reject before any socket exists
		const connection = withoutRetries(new NodeReplicationConnection(null, null, 'db', 'peer'));
		const connecting = connection.connect();
		const readers = [settlement(connection.getRecord({ id: 'a' })), settlement(connection.getRecord({ id: 'b' }))];
		await connecting;
		for (const reader of readers) assert.ok((await settled(reader, 'a waiting read')) instanceof TypeError);
		assert.strictEqual(connection.isConnected, false, 'Replicator.load must skip it rather than wait on the retry');
		assert.strictEqual(connection.reconnectScheduled, true);
	});

	it('a superseded attempt whose createWebSocket rejects leaves its successor alone', async () => {
		const connection = withoutRetries(new NodeReplicationConnection(null, null, 'db', 'peer'));
		const superseded = connection.connect();
		connection.forceReconnect();
		const successor = settlement(connection.getRecord({ id: 'a' }));
		await superseded;
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(successor.outcome, 'pending', "the successor's session belongs to the next attempt");
	});

	describe('against a peer that accepts TCP and never answers', () => {
		let server;
		let url;
		const sockets = new Set();

		before(async () => {
			server = createServer((socket) => {
				sockets.add(socket);
				socket.on('close', () => sockets.delete(socket));
			});
			server.listen(0, '127.0.0.1');
			await once(server, 'listening');
			url = `ws://127.0.0.1:${server.address().port}`;
		});

		after(() => {
			for (const socket of sockets) socket.destroy();
			server.close();
		});

		it('a superseded or unsubscribed attempt does not install the socket it opened', async () => {
			for (const supersede of [(connection) => connection.forceReconnect(), (connection) => connection.unsubscribe()]) {
				const connection = withoutRetries(new NodeReplicationConnection(url, null, 'db', 'peer'));
				const attempt = connection.connect();
				supersede(connection);
				await attempt;
				assert.strictEqual(connection.socket, undefined);
				connection.intentionallyUnsubscribed = true;
			}
		});

		it('rejects a read waiting across forceReconnect, and the superseded socket cannot reject its successor', async () => {
			const connection = withoutRetries(new NodeReplicationConnection(url, null, 'db', 'peer'));
			await connection.connect();
			const superseded = connection.socket;
			const before = settlement(connection.getRecord({ id: 'a' }));
			connection.forceReconnect();
			assert.ok((await settled(before, 'the read across forceReconnect')) instanceof Error);

			const after = settlement(connection.getRecord({ id: 'b' }));
			superseded.emit('error', new Error('late failure of the superseded attempt'));
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.strictEqual(after.outcome, 'pending', "the successor's session belongs to the next attempt");
			connection.intentionallyUnsubscribed = true;
		});
	});
});
