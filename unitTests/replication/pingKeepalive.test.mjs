/**
 * Regression coverage for the replication ping/keep-alive timeout (issue #241).
 *
 * Background: a follower cloning a large table makes slow but real progress — the sender's socket
 * buffer drains in bursts as the follower consumes, so bytes keep moving within the timeout window
 * even while the transfer is otherwise stalled. The old heuristic ("no bytes since the last ping =>
 * terminate") killed such a connection after a single interval, restarting the whole copy from zero.
 *
 * `shouldTerminateIdlePing` measures liveness from the last observed byte movement and:
 *   - terminates only after no activity for the full timeout (so a dead peer is still detected, even
 *     when the sender is parked awaiting a socket drain that will never come), and
 *   - never terminates while `pauseReasons > 0` — the receiver has intentionally stopped reading to
 *     drain its own queue, a local and self-clearing stall that the caller keeps liveness fresh during.
 */

import { expect } from 'chai';
import { shouldTerminateIdlePing } from '#src/replication/replicationConnection';

const TIMEOUT = 60_000;

describe('replication ping keep-alive — shouldTerminateIdlePing', () => {
	it('does NOT terminate while activity is within the timeout window', () => {
		expect(shouldTerminateIdlePing(0, TIMEOUT, 0)).to.equal(false);
		expect(shouldTerminateIdlePing(TIMEOUT - 1, TIMEOUT, 0)).to.equal(false);
	});

	it('terminates once no byte activity has occurred for the full timeout', () => {
		expect(shouldTerminateIdlePing(TIMEOUT, TIMEOUT, 0)).to.equal(true);
		expect(shouldTerminateIdlePing(TIMEOUT * 5, TIMEOUT, 0)).to.equal(true);
	});

	it('never terminates a receiver paused for backpressure, even past the timeout', () => {
		expect(shouldTerminateIdlePing(TIMEOUT * 10, TIMEOUT, 1)).to.equal(false);
		expect(shouldTerminateIdlePing(TIMEOUT * 10, TIMEOUT, 3)).to.equal(false);
	});

	it('honors a custom (e.g. operator-raised) timeout', () => {
		expect(shouldTerminateIdlePing(120_000, 300_000, 0)).to.equal(false);
		expect(shouldTerminateIdlePing(300_000, 300_000, 0)).to.equal(true);
	});
});
