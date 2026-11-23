/**
 * A request through a session whose socket is ending is refused before its response waiter is registered
 * (harper-pro#1083): retirement rejects the waiters it finds once, and ws drops a send on a closing socket
 * without an error.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { decode, encode } from 'msgpackr';
import { WebSocket, WebSocketServer } from 'ws';
import {
	NodeReplicationConnection,
	RequestNotSentError,
	replicateOverWS,
} from '#src/replication/replicationConnection';
import { retrievalFailsOver } from '#src/replication/replicator';

const GET_RECORD = 133;
const GET_RECORD_RESPONSE = 134;
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

async function settled(state, what) {
	await waitFor(() => state.outcome !== 'pending', what);
	return state.outcome;
}

describe('requests on an ending replication session (harper-pro#1083)', function () {
	this.timeout(10_000);
	let server, peer, client, session, sent, received;

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
				// frames encoded with the session's structures are not the ones under test
			}
		});
		if (client.readyState !== WebSocket.OPEN) await once(client, 'open');
		session = replicateOverWS(client, {}, { name: 'peer-a', replicates: true });
		sent = [];
		const send = client.send;
		client.send = function (data, ...rest) {
			sent.push(decode(data));
			return send.call(this, data, ...rest);
		};
	});

	afterEach(async () => {
		session.retire('test cleanup');
		client.terminate();
		for (const socket of server.clients) socket.terminate();
		await new Promise((resolve) => server.close(resolve));
	});

	const sentCommands = () => sent.filter((frame) => Array.isArray(frame)).map((frame) => frame[0]);
	const receivedRequests = () => received.filter((frame) => Array.isArray(frame) && frame[0] === GET_RECORD);

	for (const blobRepairOnly of [false, true]) {
		it(`rejects a${blobRepairOnly ? ' blob repair' : ''} read queued on the connection when the session retires before it runs`, async () => {
			const connection = new NodeReplicationConnection('ws://127.0.0.1:1', null, 'data', 'peer-a');
			connection.session = Promise.resolve(session);
			const read = settlement(connection.getRecord({ ...REQUEST, entry: {}, blobRepairOnly }));
			session.retire('superseded by forceReconnect');
			assert.equal(client.readyState, WebSocket.OPEN, 'retirement alone leaves the socket open');
			const error = await settled(read, 'the queued read settles');
			assert.ok(error instanceof RequestNotSentError, `unexpected ${error}`);
			assert.match(error.message, /closed before the record request was sent/);
			assert.deepEqual(sentCommands(), [], 'nothing was sent on the retired session');
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
			const error = await settled(settlement(session.getRecord(REQUEST)), 'the read settles');
			assert.ok(error instanceof RequestNotSentError, `unexpected ${error}`);
			assert.equal(client.readyState, WebSocket.CLOSING, "settled before the socket's 'close'");
			assert.deepEqual(sentCommands(), []);
		});

		it('rejects an operation request at once instead of after the close completes', async () => {
			const operation = settlement(session.sendOperation({ operation: 'cluster_status' }, 60_000));
			const error = await settled(operation, 'the operation settles');
			assert.ok(error instanceof RequestNotSentError, `unexpected ${error}`);
			assert.match(error.message, /Connection closed before operation request/);
			assert.equal(client.readyState, WebSocket.CLOSING, "settled before the socket's 'close'");
			assert.deepEqual(sentCommands(), []);
		});

		it('lets a remote read fail over while the connection still reports connected', async () => {
			const connection = new NodeReplicationConnection('ws://127.0.0.1:1', null, 'data', 'peer-a');
			connection.session = Promise.resolve(session);
			connection.isConnected = true;
			const error = await settled(settlement(connection.getRecord(REQUEST)), 'the read settles');
			assert.ok(error instanceof RequestNotSentError, `unexpected ${error}`);
			assert.equal(retrievalFailsOver(connection, error), true);
			assert.equal(retrievalFailsOver(connection, new Error('the peer refused the read')), false);
			connection.isConnected = false;
			assert.equal(retrievalFailsOver(connection, new Error('Connection closed')), true);
		});
	});

	it('answers a read on an open session, and retirement rejects one still in flight', async () => {
		const answered = settlement(session.getRecord(REQUEST));
		await waitFor(() => receivedRequests().length === 1, 'the first request reaches the peer');
		peer.send(encode([GET_RECORD_RESPONSE, receivedRequests()[0][1], null]));
		assert.deepEqual(await settled(answered, 'the answered read settles'), { value: undefined });

		const inFlight = settlement(session.getRecord(REQUEST));
		await waitFor(() => receivedRequests().length === 2, 'the second request reaches the peer');
		session.retire('superseded by forceReconnect');
		const error = await settled(inFlight, 'the in-flight read settles');
		assert.match(error.message, /Connection closed/);
		assert.ok(!(error instanceof RequestNotSentError), 'a sent request is not marked unsent');
	});
});
