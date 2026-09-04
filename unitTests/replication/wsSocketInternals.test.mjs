/**
 * Pins the `ws` internals that the `ReplicationWebSocket` type in replication/replicationConnection.ts
 * declares. `_socket` is private to `ws`, so a version bump can remove or rename it with no type error
 * and no build failure: `noteByteActivity` would silently fail the keep-alive open, and the one
 * non-optional read, in `sendAuditRecord`'s backpressure wait, would throw.
 */

import { expect } from 'chai';
import { WebSocket, WebSocketServer } from 'ws';

// .mocharc.json sets timeout: 0, so an unsettled socket wait would hang the whole unit suite.
const SOCKET_TIMEOUT_MS = 10_000;

function onceOrFail(emitter, event) {
	return new Promise((resolve, reject) => {
		const onError = (error) => {
			emitter.off(event, onEvent);
			reject(error);
		};
		const onEvent = (value) => {
			emitter.off('error', onError);
			resolve(value);
		};
		emitter.once(event, onEvent);
		emitter.once('error', onError);
	});
}

describe('ws _socket contract (ReplicationWebSocket)', function () {
	this.timeout(SOCKET_TIMEOUT_MS);

	let server;
	let client;
	let serverSocket;

	before(async () => {
		server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await onceOrFail(server, 'listening');
		client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
		[serverSocket] = await Promise.all([onceOrFail(server, 'connection'), onceOrFail(client, 'open')]);
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

	it('exposes _socket on the accepted server-side connection too', () => {
		expect(serverSocket._socket).to.not.equal(null);
		expect(serverSocket._socket.bytesRead).to.be.a('number');
	});
});
