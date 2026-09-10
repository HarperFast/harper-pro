/**
 * Coverage for `createCopyFinalizeWatchdog` — the guard for the base-copy FINALIZATION window, from
 * COPY_COMPLETE until the copy actually finishes. No other watchdog covers that window
 * (copyProgressWatchdog stops at COPY_COMPLETE, receiveWatchdog is widened to copyTimeout while copying,
 * subscriptionSetupWatchdog is paused), so a finalization that never completed parked the receiver in copy
 * mode permanently with nothing logged. These pin the "progress = alive, no progress = wedged" contract
 * and the arm/stop handoff with `maybeFinishCopy`.
 */

import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { createCopyFinalizeWatchdog } from '#src/replication/replicationConnection';

// Real timers rather than a fake clock: the shared watchdog floors its reset throttle at 100ms, so a
// threshold below that would be measuring the throttle. Waits are multiples of the threshold so a loaded
// machine cannot turn "has not fired yet" into a false pass.
const THRESHOLD = 150;

describe('createCopyFinalizeWatchdog', () => {
	it('fires onStall once when finalization makes no progress (the wedge)', async () => {
		let stalls = 0;
		const watchdog = createCopyFinalizeWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => 0,
			onStall: () => stalls++,
		});

		watchdog.reset(); // armed at COPY_COMPLETE
		await delay(THRESHOLD * 4);
		watchdog.stop();
		assert.strictEqual(stalls, 1, 'a frozen finalization fires exactly once, not in a reconnect loop');
	});

	it('does not fire while the drain is progressing', async () => {
		let stalls = 0;
		let progress = 0;
		const watchdog = createCopyFinalizeWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => progress,
			onStall: () => stalls++,
		});

		watchdog.reset();
		for (let i = 0; i < 6; i++) {
			await delay(THRESHOLD / 2);
			progress++; // a finalization gate closed
		}
		watchdog.stop();
		assert.strictEqual(stalls, 0, 'a slow but progressing finalization must never be force-reconnected');
	});

	it('self-re-arms after progress, so a drain that dies later is still caught', async () => {
		let stalls = 0;
		let progress = 0;
		const watchdog = createCopyFinalizeWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => progress,
			onStall: () => stalls++,
		});

		watchdog.reset();
		await delay(THRESHOLD / 2);
		progress++; // last sign of life
		await delay(THRESHOLD * 4); // frozen from here
		watchdog.stop();
		assert.strictEqual(stalls, 1);
	});

	it('stop() prevents firing — the maybeFinishCopy path', async () => {
		let stalls = 0;
		const watchdog = createCopyFinalizeWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => 0,
			onStall: () => stalls++,
		});

		watchdog.reset();
		watchdog.stop(); // copy finalized
		await delay(THRESHOLD * 4);
		assert.strictEqual(stalls, 0, 'a finished copy must not be reconnected out from under itself');
	});
});
