/**
 * Coverage for the jittered reconnect schedule (harper-pro#327). `scheduleReconnect` used to wait
 * exactly `retryTime`, so every node reacting to the same peer outage re-dialed on the same instant.
 * The ceiling schedule is unchanged; the draw is equal jitter (the top half of the window) rather than
 * the discipline's default full jitter, because this site's invariant is a dial *rate* — every dial
 * allocates native TLS state (harper-pro#339) — so its floor has to scale with the ceiling.
 *
 * `null` for the url makes createWebSocket reject before any socket or listener exists, which is the
 * cheapest way to drive the real scheduleReconnect path without a peer.
 */

import { expect } from 'chai';
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

		expect(early).to.not.deep.equal(late);
		for (let i = 0; i < early.length; i++) expect(early[i]).to.be.below(late[i]);
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

		expect(ceilings).to.deep.equal([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
		// Every draw sits in the top half of the ceiling it was drawn under, so the minimum interval
		// between dials never falls below half of what the jitterless schedule guaranteed.
		const ceilingFor = (i) => Math.min(INITIAL_RETRY_TIME * 2 ** i, MAX_RETRY_TIME);
		timers.values.forEach((delay, i) => {
			expect(delay).to.be.at.least(ceilingFor(i) / 2);
			expect(delay).to.be.below(ceilingFor(i));
		});
	});

	it('a zero draw still waits half the ceiling, so the dial rate stays bounded as it escalates', () => {
		expect(
			scheduleDelays(
				makeConnection(() => 0),
				4
			)
		).to.deep.equal([250, 500, 1000, 2000]);
	});

	it('retryTime reads as the initial interval before any failure', () => {
		expect(makeConnection(Math.random).retryTime).to.equal(INITIAL_RETRY_TIME);
	});

	it('onFrameSent resets the ceiling and the retry counter', () => {
		const connection = makeConnection(() => 0.5);
		scheduleDelays(connection, 3);
		connection.retries = 7;
		expect(connection.retryTime).to.equal(4000);

		connection.onFrameSent();

		expect(connection.retries).to.equal(0);
		expect(connection.retryTime).to.equal(INITIAL_RETRY_TIME);
		expect(scheduleDelays(connection, 1)[0], 'drawing under the initial ceiling again').to.equal(375);
	});
});
