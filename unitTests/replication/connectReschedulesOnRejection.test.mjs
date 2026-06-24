/**
 * Coverage for the harper-pro#466 primary fix: a connect() whose createWebSocket() rejects before any
 * socket/listener exists must reschedule another reconnect instead of dying as an unhandled rejection.
 *
 * The wedge: connect() is re-driven via setTimeout(() => this.connect()) (close handler / forceReconnect)
 * with no .catch(). createWebSocket can reject before 'open'/'error'/'close' listeners attach (no valid
 * cert yet, or SNICallback.initialize() failing while a restarted peer rebuilds its TLS secure contexts).
 * The old code cleared reconnectScheduled in a finally and let the rejection escape — leaving no socket,
 * no timer, connected:false forever. The fix routes the rejection through scheduleReconnect().
 *
 * createWebSocket is a module function (not a method) so it can't be sinon-stubbed on the instance. We
 * instead force it to reject deterministically with url = null (createWebSocket throws a TypeError for a
 * non-string URL before touching any cert/TLS machinery), which exercises the real catch path.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { NodeReplicationConnection } from '#src/replication/replicationConnection';

describe('NodeReplicationConnection connect() reschedules when createWebSocket rejects (harper-pro#466)', () => {
	let clock;
	let unhandled;
	let onUnhandled;

	beforeEach(() => {
		clock = sinon.useFakeTimers();
		unhandled = [];
		onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
	});

	afterEach(() => {
		process.off('unhandledRejection', onUnhandled);
		clock.restore();
		sinon.restore();
	});

	// url = null makes createWebSocket reject (TypeError: Invalid URL) before any socket exists or any
	// listener is attached — the exact pre-'open' rejection shape of the #466 wedge.
	function makeRejectingConnection() {
		return new NodeReplicationConnection(null, null, 'db', 'peer');
	}

	it('a createWebSocket rejection leaves reconnectScheduled=true with a pending retry, not a permanent stuck state', async () => {
		const conn = makeRejectingConnection();
		await conn.connect(); // createWebSocket rejects -> caught -> scheduleReconnect()

		expect(conn.socket, 'no socket was installed (rejected before open)').to.equal(undefined);
		expect(conn.reconnectScheduled, 'a retry is armed and tracked').to.equal(true);
		expect(conn.retryTime, 'backoff advanced past the initial interval').to.equal(1000);

		// Let unhandledRejection microtasks (if any) flush — there must be none.
		await Promise.resolve();
		expect(unhandled, 'connect() rejection did not escape as an unhandled rejection').to.deep.equal([]);
	});

	it('the armed retry actually fires another connect() (self-healing), it does not vanish', async () => {
		const conn = makeRejectingConnection();
		const connectSpy = sinon.spy(conn, 'connect');
		await conn.connect(); // first attempt rejects + schedules at retryTime=500

		expect(connectSpy.callCount, 'one attempt so far').to.equal(1);
		expect(conn.reconnectScheduled).to.equal(true);

		await clock.tickAsync(500); // fire the scheduled retry
		expect(connectSpy.callCount, 'the scheduled retry re-invoked connect()').to.equal(2);
		// Still wedged on the same null url, so it remains scheduled with a further-backed-off retry.
		expect(conn.reconnectScheduled, 'still armed for the next attempt').to.equal(true);
		expect(conn.retryTime, 'backoff doubled again').to.equal(2000);

		await Promise.resolve();
		expect(unhandled).to.deep.equal([]);
	});

	it('an intentionally-unsubscribed connection does not reschedule on a connect() rejection', async () => {
		const conn = makeRejectingConnection();
		conn.intentionallyUnsubscribed = true;
		const connectSpy = sinon.spy(conn, 'connect');
		await conn.connect(); // early-returns before createWebSocket

		expect(conn.reconnectScheduled).to.equal(false);
		await clock.tickAsync(60_000);
		expect(connectSpy.callCount, 'no retry armed for an intentional unsubscribe').to.equal(1);
	});
});
