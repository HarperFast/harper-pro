/**
 * Regression coverage for the replicated-operation keep-alive (issue #674).
 *
 * Background: `replicateOperation` → `sendOperationToNode` opens a one-shot replication WS and awaits
 * `OPERATION_RESPONSE` with no timeout. It used to build that connection with an empty `{}`, which
 * left the keep-alive ping tick disarmed — so while the peer executed the operation (a
 * deploy_component install can run for minutes) nothing was written in either direction, the receive
 * watchdog terminated the socket after 2 x replication.pingTimeout (~120s by default), and the
 * pending response rejected with `Connection closed  1006`. The peer's work is never cancelled by
 * that close, so a peer that was still installing got reported as a failed replication.
 *
 * `shouldRunKeepalive` is the gate `replicateOverWS` gives the ping tick, and
 * `operationConnectionOptions` is what the operation socket is built with; the two must agree.
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
