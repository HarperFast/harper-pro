import assert from 'node:assert';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import {
	NodeReplicationConnection,
	CONNECTION_STATE_POSITION,
	CONNECTION_STATE_CONNECTED,
	CONNECTION_STATE_DOWN,
	LAST_ERROR_CODE_POSITION,
	LAST_ERROR_TIME_POSITION,
} from '#src/replication/replicationConnection';

// the dist module object, whose disconnectedFromNode the connection reads at call time
const subscriptionManager = createRequire(import.meta.url)('#src/replication/subscriptionManager');

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

	it('an attempt unsubscribed before createWebSocket rejects settles its readers without a retry', async () => {
		const connection = withoutRetries(new NodeReplicationConnection(null, null, 'db', 'peer'));
		const attempt = connection.connect();
		const reader = settlement(connection.getRecord({ id: 'a' }));
		connection.unsubscribe();
		await attempt;
		assert.match((await settled(reader, 'the read on an unsubscribed attempt')).message, /unsubscribed/);
		assert.strictEqual(connection.reconnectScheduled, false);
		assert.strictEqual(connection.isConnected, false);
	});

	it('unsubscribing settles readers of a session that replaced the opening attempt', async () => {
		const connection = withoutRetries(new NodeReplicationConnection(null, null, 'db', 'peer'));
		const attempt = connection.connect();
		connection.forceReconnect();
		const reader = settlement(connection.getRecord({ id: 'a' }));
		connection.unsubscribe();
		await attempt;
		assert.match((await settled(reader, 'the read on the replacement session')).message, /unsubscribed/);
		assert.strictEqual(connection.isConnected, false);
	});

	describe('reporting the disconnect of a subscribed connection', () => {
		let original;
		let reports;
		beforeEach(() => {
			original = subscriptionManager.disconnectedFromNode;
			reports = [];
			subscriptionManager.disconnectedFromNode = (report) => reports.push(report);
		});
		afterEach(() => {
			subscriptionManager.disconnectedFromNode = original;
		});

		function subscribedConnection() {
			const connection = withoutRetries(new NodeReplicationConnection(null, null, 'db', 'peer'));
			connection.nodeSubscriptions = [];
			connection.sharedStatus = new Float64Array(LAST_ERROR_TIME_POSITION + 1);
			connection.sharedStatus[CONNECTION_STATE_POSITION] = CONNECTION_STATE_CONNECTED;
			return connection;
		}

		it('reports a first dial whose createWebSocket rejects, once across later failed attempts', async () => {
			const connection = subscribedConnection();
			await connection.connect();
			assert.deepStrictEqual(reports, [{ name: 'peer', database: 'db', url: null, finished: false }]);
			assert.strictEqual(connection.sharedStatus[CONNECTION_STATE_POSITION], CONNECTION_STATE_DOWN);
			assert.strictEqual(connection.sharedStatus[LAST_ERROR_CODE_POSITION], 0);
			assert.ok(connection.sharedStatus[LAST_ERROR_TIME_POSITION] > 0);
			await connection.connect();
			assert.strictEqual(reports.length, 1);
		});

		it('reports an unsubscribe before the session opens as finished', async () => {
			const connection = subscribedConnection();
			const attempt = connection.connect();
			connection.getRecord({ id: 'a' }).catch(() => {});
			connection.unsubscribe();
			await attempt;
			assert.deepStrictEqual(reports, [{ name: 'peer', database: 'db', url: null, finished: true }]);
			assert.strictEqual(connection.sharedStatus[CONNECTION_STATE_POSITION], CONNECTION_STATE_DOWN);
			assert.strictEqual(connection.sharedStatus[LAST_ERROR_CODE_POSITION], 1008);
		});
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

		it('a superseded attempt does not install the socket it opened', async () => {
			const connection = withoutRetries(new NodeReplicationConnection(url, null, 'db', 'peer'));
			const attempt = connection.connect();
			connection.forceReconnect();
			await attempt;
			assert.strictEqual(connection.socket, undefined);
			connection.intentionallyUnsubscribed = true;
		});

		it('an attempt unsubscribed while opening rejects its readers and installs nothing', async () => {
			const connection = withoutRetries(new NodeReplicationConnection(url, null, 'db', 'peer'));
			const attempt = connection.connect();
			const reader = settlement(connection.getRecord({ id: 'a' }));
			connection.unsubscribe();
			await attempt;
			assert.match((await settled(reader, 'the read on an unsubscribed attempt')).message, /unsubscribed/);
			assert.strictEqual(connection.socket, undefined);
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
