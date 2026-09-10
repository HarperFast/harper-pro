/**
 * Regression coverage for issue #674: the replicated-operation socket was built with empty options,
 * leaving the keep-alive disarmed, so the receive watchdog killed it at 2 x replication.pingTimeout
 * while the peer was still working. `operationConnectionOptions` and `shouldRunKeepalive` are the two
 * halves of that contract and must agree.
 */

import { expect } from 'chai';
import { WebSocket } from 'ws';
import { shouldRunKeepalive, keepaliveArmsOnOpen } from '#src/replication/replicationConnection';
import { operationConnectionOptions } from '#src/replication/replicator';

const PEER_URL = 'wss://peer.example.com:9933';

describe('replicated-operation connection keep-alive — issue #674', () => {
	it('builds an operation connection that arms the keep-alive', () => {
		expect(shouldRunKeepalive(operationConnectionOptions(PEER_URL))).to.equal(true);
	});

	it('pings the same peer the operation was sent to', () => {
		expect(operationConnectionOptions(PEER_URL).url).to.equal(PEER_URL);
	});

	it('leaves a server-accepted connection without a keepalive, so it relies on the client pings', () => {
		expect(shouldRunKeepalive({})).to.equal(false);
		expect(shouldRunKeepalive(undefined)).to.equal(false);
	});

	// ws.ping() throws on a CONNECTING socket, and the operation path creates the session before
	// 'open' — arming synchronously there would reject every replicated operation.
	it('defers the first ping to open while the socket is still connecting', () => {
		expect(keepaliveArmsOnOpen(WebSocket.CONNECTING)).to.equal(true);
	});

	it('arms immediately on a socket that is already open, closing or closed', () => {
		expect(keepaliveArmsOnOpen(WebSocket.OPEN)).to.equal(false);
		expect(keepaliveArmsOnOpen(WebSocket.CLOSING)).to.equal(false);
		expect(keepaliveArmsOnOpen(WebSocket.CLOSED)).to.equal(false);
	});
});
