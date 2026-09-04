/**
 * Pins the `ws` internals that `ReplicationWebSocket` (replication/replicationConnection.ts) declares.
 * `_socket` and the members replication reads through it are private to `ws`, so a version bump could
 * remove or rename them with no type error and no compile failure — the keep-alive watchdog and the
 * blob-send backpressure loop would simply stop working. This test is what fails instead.
 */

import { expect } from 'chai';
import { WebSocket, WebSocketServer } from 'ws';

describe('ws _socket contract (ReplicationWebSocket)', () => {
	let server;
	let client;
	let serverSocket;

	before(async () => {
		server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await new Promise((resolve) => server.once('listening', resolve));
		client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
		[serverSocket] = await Promise.all([
			new Promise((resolve) => server.once('connection', resolve)),
			new Promise((resolve) => client.once('open', resolve)),
		]);
	});

	after(async () => {
		client?.terminate();
		serverSocket?.terminate();
		await new Promise((resolve) => server.close(resolve));
	});

	it('is null before the handshake completes', () => {
		const pending = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
		// terminate() before the handshake completes rejects the pending connect; swallow it
		pending.on('error', () => {});
		try {
			expect(pending._socket).to.equal(null);
		} finally {
			pending.terminate();
		}
	});

	it('exposes the byte counters the keep-alive watchdog reads', () => {
		expect(client._socket.bytesRead).to.be.a('number');
		expect(client._socket.bytesWritten).to.be.a('number');
	});

	it('exposes the backpressure and lifecycle members replication calls', () => {
		expect(client._socket.writableNeedDrain).to.be.a('boolean');
		expect(client._socket.pause).to.be.a('function');
		expect(client._socket.unref).to.be.a('function');
		expect(client._socket.setMaxListeners).to.be.a('function');
		expect(client._socket.once).to.be.a('function');
		expect(client._socket.off).to.be.a('function');
	});

	it('is the same socket on both ends of an open connection', () => {
		expect(serverSocket._socket).to.not.equal(null);
		expect(serverSocket._socket.bytesRead).to.be.a('number');
	});
});
