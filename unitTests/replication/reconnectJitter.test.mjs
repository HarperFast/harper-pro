/**
 * Coverage for the jittered reconnect schedule (harper-pro#327). `scheduleReconnect` used to wait
 * exactly `retryTime`, so every node reacting to the same peer outage re-dialed on the same instant.
 * The ceiling schedule is unchanged; full jitter decorrelates the fleet, while the fixed 500 ms floor
 * retains the hard minimum interval from the native TLS-state incident (harper-pro#339).
 *
 * `null` for the url makes createWebSocket reject before any socket or listener exists, which is the
 * cheapest way to drive the real scheduleReconnect path without a peer.
 */

import assert from 'node:assert';
import sinon from 'sinon';
import { NodeReplicationConnection } from '#src/replication/replicationConnection';

const INITIAL_RETRY_TIME = 500;
const MAX_RETRY_TIME = 30_000;

function captureTimerDelays() {
	const realSetTimeout = globalThis.setTimeout;
	const values = [];
	globalThis.setTimeout = (fn, ms) => {
		values.push(ms);
		return realSetTimeout(fn, ms);
	};
	return {
		values,
		restore() {
			globalThis.setTimeout = realSetTimeout;
		},
	};
}

function scheduleDelays(connection, attempts) {
	const timers = captureTimerDelays();
	try {
		for (let i = 0; i < attempts; i++) {
			connection.reconnectScheduled = false; // the real clear happens when connect() installs a socket
			connection.scheduleReconnect();
		}
	} finally {
		timers.restore();
	}
	return timers.values;
}

describe('NodeReplicationConnection reconnect jitter (harper-pro#327)', () => {
	let clock;

	beforeEach(() => {
		clock = sinon.useFakeTimers();
	});

	afterEach(() => {
		// clock.restore() only — a sandbox-wide sinon.restore() here re-restores the stale
		// globalThis.setTimeout that receiveWatchdog.test.mjs's manually-restored spy left registered,
		// which silently breaks real timers for every file that runs after this one.
		clock.restore();
	});

	function makeConnection(random) {
		const connection = new NodeReplicationConnection(null, null, 'db', 'peer');
		connection.random = random;
		return connection;
	}

	it('two connections failing on identical timing get decorrelated delays', () => {
		const early = scheduleDelays(
			makeConnection(() => 0.1),
			6
		);
		const late = scheduleDelays(
			makeConnection(() => 0.9),
			6
		);

		assert.notDeepEqual(early, late);
		assert.equal(early[0], INITIAL_RETRY_TIME);
		for (let i = 1; i < early.length; i++) assert.ok(early[i] < late[i]);
	});

	it('keeps the unchanged 500ms → 30s ceiling schedule, drawing inside it', () => {
		const connection = makeConnection(() => 0.999999);
		const ceilings = [];
		const timers = captureTimerDelays();
		try {
			for (let i = 0; i < 8; i++) {
				connection.reconnectScheduled = false;
				connection.scheduleReconnect();
				ceilings.push(connection.retryTime);
			}
		} finally {
			timers.restore();
		}

		assert.deepEqual(ceilings, [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
		const ceilingFor = (i) => Math.min(INITIAL_RETRY_TIME * 2 ** i, MAX_RETRY_TIME);
		timers.values.forEach((delay, i) => {
			assert.ok(delay >= INITIAL_RETRY_TIME);
			if (ceilingFor(i) === INITIAL_RETRY_TIME) assert.equal(delay, INITIAL_RETRY_TIME);
			else assert.ok(delay < ceilingFor(i));
		});
	});

	it('a zero draw still waits the fixed TLS-safety floor', () => {
		assert.deepEqual(
			scheduleDelays(
				makeConnection(() => 0),
				4
			),
			[500, 500, 500, 500]
		);
	});

	it('retryTime reads as the initial interval before any failure', () => {
		assert.equal(makeConnection(Math.random).retryTime, INITIAL_RETRY_TIME);
	});

	it('onFrameSent resets the ceiling and the retry counter', () => {
		const connection = makeConnection(() => 0.5);
		scheduleDelays(connection, 3);
		connection.retries = 7;
		assert.equal(connection.retryTime, 4000);

		connection.onFrameSent();

		assert.equal(connection.retries, 0);
		assert.equal(connection.retryTime, INITIAL_RETRY_TIME);
		assert.equal(scheduleDelays(connection, 1)[0], 500, 'drawing under the initial ceiling again');
	});
});
