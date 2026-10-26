/**
 * A send range stopped at a torn tail recovers by reconnecting, at most once per floor per (database,
 * peer), so a stopped log beside busy healthy logs cannot reconnect on every commit.
 */

import { expect } from 'chai';
import {
	maybeDeadAuditIterableForTest,
	sendLogBreakReconnectDelayMs,
	SEND_LOG_BREAK_RECONNECT_INTERVAL_MS,
} from '#src/replication/replicationConnection';

const NOW = 1_000_000;

describe('sendLogBreakReconnectDelayMs', () => {
	it('allows the first reconnect immediately', () => {
		expect(sendLogBreakReconnectDelayMs(0, NOW)).to.equal(0);
	});

	it('defers a repeat for the rest of the floor rather than refusing it', () => {
		expect(sendLogBreakReconnectDelayMs(NOW, NOW + 60_000)).to.equal(SEND_LOG_BREAK_RECONNECT_INTERVAL_MS - 60_000);
	});

	it('never waits longer than the floor when the clock steps backward', () => {
		expect(sendLogBreakReconnectDelayMs(NOW, NOW - 60_000)).to.equal(SEND_LOG_BREAK_RECONNECT_INTERVAL_MS);
	});

	it('allows a repeat once the floor has passed', () => {
		expect(sendLogBreakReconnectDelayMs(NOW, NOW + SEND_LOG_BREAK_RECONNECT_INTERVAL_MS)).to.equal(0);
		expect(sendLogBreakReconnectDelayMs(NOW, NOW + 2 * SEND_LOG_BREAK_RECONNECT_INTERVAL_MS)).to.equal(0);
	});
});

describe('maybeDeadAuditIterableForTest', () => {
	it('is inert without the test environment variable', () => {
		expect(maybeDeadAuditIterableForTest('data')).to.equal(undefined);
	});
});
