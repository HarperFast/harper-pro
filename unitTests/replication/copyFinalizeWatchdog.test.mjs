/**
 * Coverage for `createCopyFinalizeWatchdog` — the guard for the base-copy FINALIZATION window, from
 * COPY_COMPLETE until the copy actually finishes. No other watchdog covers that window
 * (copyProgressWatchdog stops at COPY_COMPLETE, receiveWatchdog is widened to copyTimeout while copying,
 * subscriptionSetupWatchdog is paused), so a finalization that never completed parked the receiver in copy
 * mode permanently with nothing logged. These pin the "progress = alive, no progress = wedged" contract
 * and the arm/stop handoff with `maybeFinishCopy`.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { createCopyFinalizeWatchdog } from '#src/replication/replicationConnection';

const THRESHOLD = 300_000; // stand-in for COPY_FINALIZE_TIMEOUT; the factory takes it as a param

describe('createCopyFinalizeWatchdog', () => {
	let clock;

	beforeEach(() => {
		clock = sinon.useFakeTimers();
	});

	afterEach(() => {
		clock.restore();
	});

	it('fires onStall once after thresholdMs when finalization makes no progress (the finalization wedge)', () => {
		const onStall = sinon.spy();
		const watchdog = createCopyFinalizeWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => 0, // no commit drained, no blob finished, no flush settled
			onStall,
		});

		watchdog.reset(); // armed at COPY_COMPLETE

		clock.tick(THRESHOLD - 1);
		expect(onStall.callCount).to.equal(0);

		clock.tick(1);
		expect(onStall.callCount).to.equal(1);
	});

	it('does NOT fire while the drain is progressing (a big copy finalizing slowly)', () => {
		const onStall = sinon.spy();
		let progress = 0;
		const watchdog = createCopyFinalizeWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => progress,
			onStall,
		});

		watchdog.reset();
		// 20 windows, each with one tick of progress just before the deadline.
		for (let i = 0; i < 20; i++) {
			clock.tick(THRESHOLD - 1);
			progress += 1; // a blob finished / a cursor flush succeeded
			clock.tick(1); // watchdog checks, sees progress, re-arms from the new baseline
		}
		expect(onStall.callCount).to.equal(0);
	});

	it('self-re-arms after progress, so a drain that dies LATER is still caught', () => {
		const onStall = sinon.spy();
		let progress = 0;
		const watchdog = createCopyFinalizeWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => progress,
			onStall,
		});

		watchdog.reset(); // t=0, baseline 0, timer at t=THRESHOLD
		clock.tick(THRESHOLD - 1);
		progress = 1; // last commit drained just before the first deadline
		clock.tick(1); // t=THRESHOLD: progress advanced → re-baseline to 1, re-arm at t=2*THRESHOLD

		clock.tick(THRESHOLD - 1);
		expect(onStall.callCount).to.equal(0);
		clock.tick(1); // t=2*THRESHOLD: progress unchanged → fires
		expect(onStall.callCount).to.equal(1);
	});

	it('stop() prevents firing — the maybeFinishCopy path', () => {
		const onStall = sinon.spy();
		const watchdog = createCopyFinalizeWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => 0,
			onStall,
		});

		watchdog.reset();
		clock.tick(THRESHOLD - 1);
		watchdog.stop(); // copy finalized
		clock.tick(THRESHOLD * 3);
		expect(onStall.callCount).to.equal(0);
	});

	it('fires only once per stall — the reconnect drives recovery, not a repeated timer', () => {
		const onStall = sinon.spy();
		const watchdog = createCopyFinalizeWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => 0,
			onStall,
		});

		watchdog.reset();
		clock.tick(THRESHOLD * 5);
		expect(onStall.callCount).to.equal(1);
	});
});
