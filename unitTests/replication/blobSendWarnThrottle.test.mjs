/**
 * Coverage for the blob-send visibility warning throttle (see sendBlobs in
 * replicationConnection.ts): warn once a queued send has parked on the concurrency cap past a
 * threshold, warn once more when it unparks, and warn (throttled) on each declined send — all
 * without spamming logs when a burst of sends hits the same condition at once.
 */

import { execFileSync } from 'node:child_process';
import { expect } from 'chai';
import { createThrottleState, decideThrottledWarn, WARN_THROTTLE_MS } from '#src/replication/blobSendWarnThrottle';

const parkWarnEnvName = 'HARPER_BLOB_SEND_PARK_WARN_MS';

function readParkWarnMs(value) {
	const env = { ...process.env };
	if (value == null) delete env[parkWarnEnvName];
	else env[parkWarnEnvName] = value;
	return Number(
		execFileSync(
			process.execPath,
			[
				'--input-type=module',
				'--eval',
				"import { PARK_WARN_MS } from '#src/replication/blobSendWarnThrottle'; process.stdout.write(String(PARK_WARN_MS));",
			],
			{ cwd: new URL('../..', import.meta.url), encoding: 'utf8', env }
		)
	);
}

describe('blobSendWarnThrottle', () => {
	describe('PARK_WARN_MS', () => {
		it('allows an immediate warning', () => {
			expect(readParkWarnMs('0')).to.equal(0);
		});

		it('defaults when the environment variable is unset or invalid', () => {
			expect(readParkWarnMs(undefined)).to.equal(5000);
			expect(readParkWarnMs('invalid')).to.equal(5000);
		});

		it('clamps negative values to zero', () => {
			expect(readParkWarnMs('-1')).to.equal(0);
		});
	});

	describe('createThrottleState', () => {
		it('starts fresh so the very first decision always emits', () => {
			const state = createThrottleState();
			const decision = decideThrottledWarn(state, 1_000, WARN_THROTTLE_MS);
			expect(decision.emit).to.equal(true);
			expect(decision.suppressedCount).to.equal(0);
		});
	});

	describe('decideThrottledWarn', () => {
		it('suppresses subsequent decisions within the throttle window', () => {
			const state = createThrottleState();
			expect(decideThrottledWarn(state, 0, WARN_THROTTLE_MS).emit).to.equal(true);
			const second = decideThrottledWarn(state, 1000, WARN_THROTTLE_MS);
			expect(second.emit).to.equal(false);
			expect(second.suppressedCount).to.equal(1);
			const third = decideThrottledWarn(state, 2000, WARN_THROTTLE_MS);
			expect(third.emit).to.equal(false);
			expect(third.suppressedCount).to.equal(2);
		});

		it('emits again once the throttle window has elapsed, folding in the suppressed count', () => {
			const state = createThrottleState();
			decideThrottledWarn(state, 0, WARN_THROTTLE_MS); // emits
			decideThrottledWarn(state, 1000, WARN_THROTTLE_MS); // suppressed (1)
			decideThrottledWarn(state, 2000, WARN_THROTTLE_MS); // suppressed (2)
			const emitted = decideThrottledWarn(state, WARN_THROTTLE_MS, WARN_THROTTLE_MS);
			expect(emitted.emit).to.equal(true);
			expect(emitted.suppressedCount).to.equal(2); // count suppressed since the LAST emitted warning
		});

		it('resets the suppressed count after each emitted warning', () => {
			const state = createThrottleState();
			decideThrottledWarn(state, 0, WARN_THROTTLE_MS); // emits, suppressedCount reset to 0
			const emittedAgain = decideThrottledWarn(state, WARN_THROTTLE_MS, WARN_THROTTLE_MS);
			expect(emittedAgain.emit).to.equal(true);
			expect(emittedAgain.suppressedCount).to.equal(0); // nothing was suppressed in between
		});

		it('treats independent throttle states independently (one bucket cannot suppress another)', () => {
			const parkState = createThrottleState();
			const declineState = createThrottleState();
			expect(decideThrottledWarn(parkState, 0, WARN_THROTTLE_MS).emit).to.equal(true);
			// A decline warning at the same instant is a different bucket, so it still emits.
			expect(decideThrottledWarn(declineState, 0, WARN_THROTTLE_MS).emit).to.equal(true);
		});
	});
});
