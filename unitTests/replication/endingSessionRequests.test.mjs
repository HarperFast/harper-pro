/**
 * A request made through a session whose socket is ending must be refused before its response waiter is
 * registered (harper-pro#1083). Retirement rejects the waiters it finds once, and ws drops a send on a closing
 * socket without an error, so a waiter registered after either would wait for an answer that cannot come.
 * These drive a real `replicateOverWS` session over the locked `ws` client against a local server.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { decode, encode } from 'msgpackr';
import { WebSocket, WebSocketServer } from 'ws';
import { NodeReplicationConnection, replicateOverWS } from '#src/replication/replicationConnection';

const GET_RECORD = 133;
const GET_RECORD_RESPONSE = 134;
const OPERATION_REQUEST = 136;
const BOUND = 1000;
const REQUEST = { id: 'k', table: { tableId: 1, tableName: 'SomeTable' } };

function settlement(promise) {
	const state = { outcome: 'pending' };
	promise.then(
		(value) => (state.outcome = { value }),
		(error) => (state.outcome = error)
	);
	return state;
}

async function waitFor(predicate, what) {
	const deadline = Date.now() + BOUND;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, `${what} within ${BOUND}ms`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe('requests on an ending replication session (harper-pro#1083)', function () {
	this.timeout(10_000);
	let server, peer, client, session, received;

	beforeEach(async () => {
		server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await once(server, 'listening');
		received = [];
		const connected = once(server, 'connection');
		client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
		[peer] = await connected;
		peer.on('message', (data) => {
			try {
				received.push(decode(data));
			} catch {
				// frames that need the session's structures are not the ones under test
			}
		});
		if (client.readyState !== WebSocket.OPEN) await once(client, 'open');
		session = replicateOverWS(client, {}, { name: 'peer-a', replicates: true });
	});

	afterEach(async () => {
		session.retire('test cleanup');
		client.terminate();
		for (const socket of server.clients) socket.terminate();
		await new Promise((resolve) => server.close(resolve));
	});

	const sentRequests = (command) => received.filter((frame) => Array.isArray(frame) && frame[0] === command);

	for (const blobRepairOnly of [false, true]) {
		it(`rejects a${blobRepairOnly ? ' blob repair' : ''} read queued on the connection when the session retires before it runs`, async () => {
			const connection = new NodeReplicationConnection('ws://127.0.0.1:1', null, 'data', 'peer-a');
			connection.session = Promise.resolve(session);
			const read = settlement(connection.getRecord({ ...REQUEST, entry: {}, blobRepairOnly }));
			// the read's continuation is queued behind the resolved session; retire it first, as forceReconnect does
			session.retire('superseded by forceReconnect');
			assert.equal(client.readyState, WebSocket.OPEN, 'retirement alone leaves the socket open');
			await waitFor(() => read.outcome !== 'pending', 'the queued read settles');
			assert.match(read.outcome.message, /closed before the record request was sent/);
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.deepEqual(sentRequests(GET_RECORD), [], 'no request went out on the retired session');
		});
	}

	describe('on a socket that is closing', () => {
		beforeEach(() => {
			// The peer never reads our close frame, so 'close' waits for ws's closing-handshake timeout.
			peer._socket.pause();
			client.close(1000);
			assert.equal(client.readyState, WebSocket.CLOSING);
		});

		it('rejects a record request at once instead of after the close completes', async () => {
			const read = settlement(session.getRecord(REQUEST));
			await waitFor(() => read.outcome !== 'pending', 'the read settles');
			assert.match(read.outcome.message, /closed before the record request was sent/);
			assert.equal(client.readyState, WebSocket.CLOSING, "settled before the socket's 'close'");
		});

		it('rejects an operation request at once instead of after the close completes', async () => {
			const operation = settlement(session.sendOperation({ operation: 'cluster_status' }));
			await waitFor(() => operation.outcome !== 'pending', 'the operation settles');
			assert.match(operation.outcome.message, /Connection closed before operation request/);
			assert.equal(client.readyState, WebSocket.CLOSING, "settled before the socket's 'close'");
			assert.deepEqual(sentRequests(OPERATION_REQUEST), []);
		});
	});

	it('answers a read on an open session, and retirement rejects one still in flight', async () => {
		const answered = settlement(session.getRecord(REQUEST));
		await waitFor(() => sentRequests(GET_RECORD).length === 1, 'the first request reaches the peer');
		peer.send(encode([GET_RECORD_RESPONSE, sentRequests(GET_RECORD)[0][1], null]));
		await waitFor(() => answered.outcome !== 'pending', 'the answered read settles');
		assert.deepEqual(answered.outcome, { value: undefined });

		const inFlight = settlement(session.getRecord(REQUEST));
		await waitFor(() => sentRequests(GET_RECORD).length === 2, 'the second request reaches the peer');
		session.retire('superseded by forceReconnect');
		await waitFor(() => inFlight.outcome !== 'pending', 'the in-flight read settles');
		assert.match(inFlight.outcome.message, /Connection closed/);
	});
});
