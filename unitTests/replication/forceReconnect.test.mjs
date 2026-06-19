/**
 * Coverage for `NodeReplicationConnection.forceReconnect` — the receive-watchdog recovery path added
 * for harper-pro#420. A socket that connected and then went open-but-idle (copy stalls, no transport
 * close) never emits 'close', so the close handler's retry never arms and the wedge reconciler skips
 * the still-connected:true entry. forceReconnect drives recovery directly: it tears the socket down
 * and schedules one fresh connect, independent of whether a 'close' ever fires.
 *
 * These tests pin the decision logic in isolation (connect() is stubbed so no real socket is opened):
 * it reconnects exactly once, never double-arms with a concurrent call, and never revives a connection
 * that was deliberately torn down.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { NodeReplicationConnection } from '#src/replication/replicationConnection';

describe('NodeReplicationConnection.forceReconnect', () => {
	let clock;

	beforeEach(() => {
		clock = sinon.useFakeTimers();
	});

	afterEach(() => {
		clock.restore();
		sinon.restore();
	});

	// A connection with connect() stubbed and a fake socket — exercises forceReconnect without
	// opening a real WebSocket. nodeSubscriptions is left unset so the disconnect notification
	// (covered by the integration test) is not invoked here.
	function makeConnection() {
		const conn = new NodeReplicationConnection('wss://peer/db', null, 'db', 'peer');
		// Mirror the real connect(): a (re)connect installs a new socket and clears the forceReconnect
		// suppression flag in its finally. The flag is intentionally NOT cleared by forceReconnect's timer.
		sinon.stub(conn, 'connect').callsFake(async () => {
			conn.reconnectScheduled = false;
		});
		conn.socket = { terminate: sinon.spy() };
		return conn;
	}

	it('tears down the socket, marks disconnected, and schedules one fresh connect', () => {
		const conn = makeConnection();
		conn.forceReconnect();

		expect(conn.socket.terminate.callCount, 'socket terminated').to.equal(1);
		expect(conn.isConnected, 'flipped to disconnected for the reconciler backstop').to.equal(false);
		expect(conn.reconnectScheduled).to.equal(true);
		expect(conn.connect.callCount, 'connect is deferred, not immediate').to.equal(0);

		clock.tick(500); // INITIAL_RETRY_TIME
		expect(conn.connect.callCount, 'reconnected after the backoff').to.equal(1);
		expect(conn.reconnectScheduled, 'cleared by connect() once the reconnect fired').to.equal(false);
	});

	it('drops the stale subscriptions-updated listener so it does not leak across wedge cycles', () => {
		const conn = makeConnection();
		conn.on('subscriptions-updated', () => {});
		expect(conn.listenerCount('subscriptions-updated')).to.equal(1);
		conn.forceReconnect();
		// The close handler's removeAllListeners is skipped for a superseded socket (socket-identity
		// guard), so forceReconnect must drop the listener itself or it accumulates each recovery cycle.
		expect(conn.listenerCount('subscriptions-updated'), 'stale listener dropped before reconnect').to.equal(0);
	});

	it('does not arm a second connect while one is already pending', () => {
		const conn = makeConnection();
		conn.forceReconnect();
		conn.forceReconnect(); // watchdog could fire again before the first reconnect lands

		expect(conn.socket.terminate.callCount, 'second call is a no-op').to.equal(1);
		clock.tick(60_000);
		expect(conn.connect.callCount, 'exactly one reconnect for the drop').to.equal(1);
	});

	it('does not revive an intentionally unsubscribed connection', () => {
		const conn = makeConnection();
		conn.intentionallyUnsubscribed = true;
		conn.forceReconnect();

		clock.tick(60_000);
		expect(conn.connect.callCount).to.equal(0);
		expect(conn.socket.terminate.callCount).to.equal(0);
	});

	it('does not revive a finished connection', () => {
		const conn = makeConnection();
		conn.isFinished = true;
		conn.forceReconnect();

		clock.tick(60_000);
		expect(conn.connect.callCount).to.equal(0);
		expect(conn.socket.terminate.callCount).to.equal(0);
	});

	it('backs off the retry interval on repeated wedges (mirrors the close-handler backoff)', () => {
		const conn = makeConnection();

		conn.forceReconnect(); // retryTime 500 -> 1000
		clock.tick(500);
		expect(conn.connect.callCount).to.equal(1);

		conn.forceReconnect(); // retryTime 1000 -> 2000
		clock.tick(999);
		expect(conn.connect.callCount, 'second reconnect waits the doubled interval').to.equal(1);
		clock.tick(1);
		expect(conn.connect.callCount).to.equal(2);
	});
});
