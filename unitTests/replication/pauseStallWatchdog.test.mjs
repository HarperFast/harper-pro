/**
 * Coverage for `createPauseStallWatchdog` — the liveness watchdog that guards a replication WS while
 * it is paused for back-pressure, the window the byte-silence `createReceiveWatchdog` is blind to.
 *
 * Background (harper-pro#466, the deferred third recovery layer of PR #467): while the receive socket
 * is paused (`pauseReasons > 0`) the byte watchdog is `stop()`ed — `ws.pause()` freezes `bytesRead`,
 * so it cannot tell a healthy back-pressure pause from a peer that died mid-pause — and the active
 * sendPing is exempt for the same reason. That left a paused leg (e.g. a base copy stalled at ~100%
 * back-pressure whose peer restarted) with NO recovery driver, wedging `connected:false` forever.
 *
 * The pause-stall watchdog closes that hole: it runs only while paused and keys off a monotonic
 * consumer-progress counter (bumped by `onCommit` and by in-flight blob streams draining to disk —
 * signals that survive `ws.pause()`) instead of socket bytes. A pause that is legitimately making
 * progress re-arms every window and never fires; only ZERO progress for the full threshold trips it.
 * These tests pin that "progress = alive, no progress = dead" contract and the arm/stop handoff.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { createPauseStallWatchdog } from '#src/replication/replicationConnection';

const THRESHOLD = 120_000; // arbitrary stand-in for PAUSE_STALL_THRESHOLD_MS; the factory takes it as a param

describe('createPauseStallWatchdog', () => {
	let clock;

	beforeEach(() => {
		clock = sinon.useFakeTimers();
	});

	afterEach(() => {
		clock.restore();
	});

	it('fires onStall once after thresholdMs when consumer progress is frozen (the #466 mid-pause death)', () => {
		// The peer died while we were paused: the consumer can never drain the queue, so the pause
		// will never self-clear. Progress stays frozen → forceReconnect must fire.
		const onStall = sinon.spy();
		const watchdog = createPauseStallWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => 0, // consumer made no progress at all while paused
			onStall,
		});

		watchdog.reset(); // armed at pause start

		clock.tick(THRESHOLD - 1);
		expect(onStall.callCount).to.equal(0);

		clock.tick(1);
		expect(onStall.callCount).to.equal(1);
	});

	it('does NOT fire when consumer progress advanced during the interval (healthy back-pressure)', () => {
		// A pause where the apply loop is still committing / blobs still draining is healthy
		// back-pressure, not a dead peer. Even one tick of progress must keep it alive.
		const onStall = sinon.spy();
		let progress = 0;
		const watchdog = createPauseStallWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => progress,
			onStall,
		});

		watchdog.reset();
		progress += 1; // consumer committed a batch (or a blob drained) — proof the pause is draining
		clock.tick(THRESHOLD);
		expect(onStall.callCount).to.equal(0);
	});

	it('sustained healthy back-pressure never fires: progress every window keeps re-arming', () => {
		// The critical guard. A long pause that keeps making progress (a large base copy under steady
		// back-pressure) must NOT be force-reconnected no matter how long it lasts.
		const onStall = sinon.spy();
		let progress = 0;
		const watchdog = createPauseStallWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => progress,
			onStall,
		});

		watchdog.reset();
		// 20 windows, each with a single tick of progress just before the deadline.
		for (let i = 0; i < 20; i++) {
			clock.tick(THRESHOLD - 1);
			progress += 1; // consumer drained something this window
			clock.tick(1); // watchdog checks, sees progress, re-arms from the new baseline
		}
		expect(onStall.callCount).to.equal(0);
	});

	it('self-re-arms after progress, so a peer that dies LATER is still caught', () => {
		// Progress for a while, then the peer dies mid-pause and progress freezes. The watchdog must
		// re-arm on the observed progress and then fire once progress stops — within thresholdMs of
		// the last re-arm (worst case 2× thresholdMs from when progress actually stopped).
		const onStall = sinon.spy();
		let progress = 0;
		const watchdog = createPauseStallWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => progress,
			onStall,
		});

		watchdog.reset(); // t=0, baseline 0, timer at t=THRESHOLD
		clock.tick(THRESHOLD - 1);
		progress = 1; // last sign of life just before the first deadline
		clock.tick(1); // t=THRESHOLD: progress advanced → re-baseline to 1, re-arm at t=2*THRESHOLD

		// Peer dies now — progress frozen at 1 from here on.
		clock.tick(THRESHOLD - 1);
		expect(onStall.callCount).to.equal(0);
		clock.tick(1); // t=2*THRESHOLD: progress unchanged → fires
		expect(onStall.callCount).to.equal(1);
	});

	it('stop() prevents firing — the resume path (removePauseReason)', () => {
		// removePauseReason() stop()s this watchdog when the socket resumes; the byte watchdog takes
		// back over. A pending stall timer must not fire after stop().
		const onStall = sinon.spy();
		const watchdog = createPauseStallWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => 0,
			onStall,
		});

		watchdog.reset(); // paused
		clock.tick(THRESHOLD / 2);
		watchdog.stop(); // resumed before the stall threshold
		clock.tick(THRESHOLD);
		expect(onStall.callCount).to.equal(0);
	});

	it('reset() after stop() re-arms — the pause → resume → pause cycle', () => {
		// Production shape: a leg can pause, resume, then pause again. The watchdog must guard each
		// new pause, not stay dead after the first resume.
		const onStall = sinon.spy();
		const watchdog = createPauseStallWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => 0,
			onStall,
		});

		watchdog.reset(); // pause 1
		watchdog.stop(); // resume 1
		watchdog.reset(); // pause 2

		clock.tick(THRESHOLD);
		expect(onStall.callCount).to.equal(1);
	});

	it('snapshots progress at reset() time, not construction — pre-pause progress does not suppress the first window', () => {
		// If the snapshot were taken at construction, progress that happened BEFORE the pause began
		// would make the first paused window look "alive" even though nothing advances during it.
		// reset() (called at pause start) must re-snapshot.
		const onStall = sinon.spy();
		let progress = 0;
		const watchdog = createPauseStallWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => progress,
			onStall,
		});

		progress = 5_000; // lots of progress before the pause, but the watchdog isn't armed yet
		watchdog.reset(); // pause starts now — baseline must capture 5_000
		// No progress during the paused window.
		clock.tick(THRESHOLD);
		expect(onStall.callCount).to.equal(1);
	});

	it('re-arms cleanly across repeated firings (forceReconnect failed, new leg also wedges paused)', () => {
		const onStall = sinon.spy();
		const watchdog = createPauseStallWatchdog({
			thresholdMs: THRESHOLD,
			getProgress: () => 0,
			onStall,
		});

		watchdog.reset();
		clock.tick(THRESHOLD);
		expect(onStall.callCount).to.equal(1);

		watchdog.reset();
		clock.tick(THRESHOLD);
		expect(onStall.callCount).to.equal(2);
	});
});
