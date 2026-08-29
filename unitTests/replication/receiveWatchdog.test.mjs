/**
 * Coverage for `createReceiveWatchdog` — the byte-aware silence detector added to
 * `replicateOverWS` so that a silently-dead replication WS gets terminated instead of staying
 * permanently stuck. See harper-pro#233 for the field failure modes this guards against.
 *
 * The watchdog tracks `bytesRead` only — outbound writes (our own sendPing or replication
 * payloads) are not proof of peer health and must not suppress `onSilence`. These tests pin
 * that invariant alongside the standard arm / fire / cancel behavior.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { createReceiveWatchdog } from '#src/replication/replicationConnection';

describe('createReceiveWatchdog', () => {
	let clock;

	beforeEach(() => {
		clock = sinon.useFakeTimers();
	});

	afterEach(() => {
		clock.restore();
	});

	it('fires onSilence once after intervalMs when bytesRead is unchanged', () => {
		const onSilence = sinon.spy();
		const watchdog = createReceiveWatchdog({
			intervalMs: 60_000,
			getBytesRead: () => 100,
			onSilence,
		});

		watchdog.reset();

		// Just before the deadline — must not fire yet
		clock.tick(59_999);
		expect(onSilence.callCount).to.equal(0);

		// At the deadline — fires once
		clock.tick(1);
		expect(onSilence.callCount).to.equal(1);
	});

	it('does NOT fire onSilence when bytesRead has changed during the interval', () => {
		const onSilence = sinon.spy();
		let bytesRead = 100;
		const watchdog = createReceiveWatchdog({
			intervalMs: 60_000,
			getBytesRead: () => bytesRead,
			onSilence,
		});

		watchdog.reset();
		bytesRead += 1; // single byte of incoming traffic is proof of life
		clock.tick(60_000);
		expect(onSilence.callCount).to.equal(0);
	});

	it('outbound-only activity does NOT suppress onSilence (regression for harper-pro#233 codex P2)', () => {
		// The harper-pro#233 fix MUST NOT treat our own outbound bytes as proof the peer is
		// alive — otherwise the missed-sendPing scenario the watchdog exists for is exactly
		// the case where our own pings keep `bytesWritten` advancing while `bytesRead` stays
		// stuck. The watchdog must look at bytesRead only.
		const onSilence = sinon.spy();
		const watchdog = createReceiveWatchdog({
			intervalMs: 60_000,
			getBytesRead: () => 100, // peer is silent — bytesRead never changes
			onSilence,
		});

		// Simulate the host actively writing during the interval (sendPing tick, replication
		// payload). This must not be visible to the watchdog at all.
		watchdog.reset();
		clock.tick(60_000);

		expect(onSilence.callCount).to.equal(1);
	});

	it('reset() clears the previous timer so back-to-back resets do not stack', () => {
		const onSilence = sinon.spy();
		const watchdog = createReceiveWatchdog({
			intervalMs: 60_000,
			getBytesRead: () => 0,
			onSilence,
		});

		watchdog.reset();
		clock.tick(30_000);
		watchdog.reset(); // sliding window starts over
		clock.tick(30_000);

		// 60s elapsed total but the second reset restarted the clock — not yet firing
		expect(onSilence.callCount).to.equal(0);

		clock.tick(30_000);
		expect(onSilence.callCount).to.equal(1);
	});

	it('stop() prevents onSilence from firing on a pending timer', () => {
		const onSilence = sinon.spy();
		const watchdog = createReceiveWatchdog({
			intervalMs: 60_000,
			getBytesRead: () => 0,
			onSilence,
		});

		watchdog.reset();
		clock.tick(30_000);
		watchdog.stop();
		clock.tick(60_000);

		expect(onSilence.callCount).to.equal(0);
	});

	it('reset() after stop() rearms the watchdog (the pause→resume path)', () => {
		// This is the production shape: `addPauseReason` calls `stop()` when the WS is paused
		// for backpressure, `removePauseReason` calls `reset()` when it resumes. The watchdog
		// must not be permanently dead after a pause cycle.
		const onSilence = sinon.spy();
		const watchdog = createReceiveWatchdog({
			intervalMs: 60_000,
			getBytesRead: () => 0,
			onSilence,
		});

		watchdog.reset();
		watchdog.stop();
		watchdog.reset();

		clock.tick(60_000);
		expect(onSilence.callCount).to.equal(1);
	});

	it('captures the byte snapshot at reset() time, not at construction', () => {
		// Field bug shape: if the snapshot were taken at construction, a noisy startup phase
		// would seed it stale and the very first interval would spuriously fire even though
		// the connection was actively transferring data. reset() must re-snapshot.
		const onSilence = sinon.spy();
		let bytesRead = 0;
		const watchdog = createReceiveWatchdog({
			intervalMs: 60_000,
			getBytesRead: () => bytesRead,
			onSilence,
		});

		bytesRead = 1_000; // simulate traffic before the first reset
		watchdog.reset();
		bytesRead = 1_001; // one byte of activity during the interval

		clock.tick(60_000);
		expect(onSilence.callCount).to.equal(0);
	});

	it('repeated firings: after first onSilence, a fresh reset re-arms cleanly', () => {
		// If the watchdog ever needs to fire twice (e.g. the close handler retries and the new
		// connection also goes silent), the same instance should still arm correctly.
		const onSilence = sinon.spy();
		const watchdog = createReceiveWatchdog({
			intervalMs: 60_000,
			getBytesRead: () => 0,
			onSilence,
		});

		watchdog.reset();
		clock.tick(60_000);
		expect(onSilence.callCount).to.equal(1);

		watchdog.reset();
		clock.tick(60_000);
		expect(onSilence.callCount).to.equal(2);
	});

	it('throttles rapid reset() calls so high-throughput message storms do not churn timers', () => {
		// Gemini flagged this in cross-model review: ws.on('message') resets the watchdog on
		// every frame, and at thousands of frames/sec the raw clearTimeout+setTimeout cycle is
		// non-trivial overhead. The throttle coalesces calls inside a short window.
		const onSilence = sinon.spy();
		const setTimeoutSpy = sinon.spy(globalThis, 'setTimeout');
		const clearTimeoutSpy = sinon.spy(globalThis, 'clearTimeout');
		try {
			const watchdog = createReceiveWatchdog({
				intervalMs: 60_000,
				getBytesRead: () => 0,
				onSilence,
			});

			// First reset arms.
			watchdog.reset();
			const armingsAfterFirst = setTimeoutSpy.callCount;
			expect(armingsAfterFirst).to.be.at.least(1);

			// Flood: 1000 resets within the throttle window — must not arm new timers.
			for (let i = 0; i < 1000; i++) {
				clock.tick(0); // no time passes between calls
				watchdog.reset();
			}
			expect(setTimeoutSpy.callCount).to.equal(
				armingsAfterFirst,
				'flood of resets within throttle window must not trigger setTimeout'
			);

			// After the throttle window elapses, the next reset re-arms.
			clock.tick(2_000); // exceeds the throttle's 1s upper bound
			watchdog.reset();
			expect(setTimeoutSpy.callCount).to.be.greaterThan(armingsAfterFirst);
		} finally {
			setTimeoutSpy.restore();
			clearTimeoutSpy.restore();
		}
	});

	it('silence is detected after a normal sequence of un-throttled resets stops', () => {
		// Spaced at >= throttleMs (1s here), so each reset bypasses the throttle and re-arms
		// cleanly. This is the typical "peer was healthy, then dies" trajectory.
		const onSilence = sinon.spy();
		const watchdog = createReceiveWatchdog({
			intervalMs: 60_000,
			getBytesRead: () => 0,
			onSilence,
		});

		for (let i = 0; i < 30; i++) {
			watchdog.reset();
			clock.tick(1_000);
		}
		// Last reset was at t=29s (the 30th iteration's reset, fired before the trailing tick).
		// Clock is now at t=30s. Timer is scheduled to fire at t=89s — i.e. 59s from here.
		expect(onSilence.callCount).to.equal(0);
		clock.tick(58_999);
		expect(onSilence.callCount).to.equal(0);
		clock.tick(1);
		expect(onSilence.callCount).to.equal(1);
	});

	it('intervalMs as a function is resolved at each arm, so a copy-phase widen takes effect (harper-pro#460)', () => {
		// The byte watchdog passes a function for intervalMs so it can return PING_TIMEOUT normally and a
		// wider COPY_TIMEOUT while inCopyMode. Flipping the function's result mid-life must change the
		// next armed interval rather than being frozen at construction time.
		const onSilence = sinon.spy();
		let inCopyMode = false;
		const watchdog = createReceiveWatchdog({
			intervalMs: () => (inCopyMode ? 300_000 : 60_000),
			getBytesRead: () => 0,
			onSilence,
		});

		// Normal phase: fires at the 60s ping timeout.
		watchdog.reset();
		clock.tick(60_000);
		expect(onSilence.callCount).to.equal(1);

		// Enter copy mode and re-arm: the same instance now tolerates 60s of silence without firing...
		inCopyMode = true;
		watchdog.reset();
		clock.tick(60_000);
		expect(onSilence.callCount).to.equal(1);

		// ...and only fires once the wider copy threshold elapses.
		clock.tick(240_000);
		expect(onSilence.callCount).to.equal(2);
	});

	describe('transport-evidence gate (harper-pro#697)', () => {
		it('defers instead of firing when the transport counter is also frozen for the window', () => {
			const onSilence = sinon.spy();
			const watchdog = createReceiveWatchdog({
				intervalMs: 60_000,
				getBytesRead: () => 0,
				getTransportActivity: () => 500,
				onSilence,
			});

			watchdog.reset();
			clock.tick(180_000); // three full windows, both counters frozen
			expect(onSilence.callCount).to.equal(0);
		});

		it('fires after two consecutive copy-silent windows with peer-byte movement (the #453 wedge signature)', () => {
			const onSilence = sinon.spy();
			let transportBytes = 500;
			const watchdog = createReceiveWatchdog({
				intervalMs: 60_000,
				getBytesRead: () => 0,
				getTransportActivity: () => transportBytes,
				onSilence,
			});

			watchdog.reset();
			transportBytes += 10; // a pong arrived; the peer is alive yet sends no copy frames
			clock.tick(60_000); // first evidence window — held as a pending strike
			expect(onSilence.callCount).to.equal(0);
			transportBytes += 10; // pongs keep coming
			clock.tick(60_000); // second consecutive evidence window — confirmed
			expect(onSilence.callCount).to.equal(1);
		});

		it('a deferred dark window still fires later once sustained transport evidence appears', () => {
			const onSilence = sinon.spy();
			let transportBytes = 500;
			const watchdog = createReceiveWatchdog({
				intervalMs: 60_000,
				getBytesRead: () => 0,
				getTransportActivity: () => transportBytes,
				onSilence,
			});

			watchdog.reset();
			clock.tick(60_000); // dark window → deferred
			expect(onSilence.callCount).to.equal(0);
			transportBytes += 10;
			clock.tick(60_000); // first evidence window → pending strike
			expect(onSilence.callCount).to.equal(0);
			transportBytes += 10;
			clock.tick(60_000); // second consecutive evidence window → fire
			expect(onSilence.callCount).to.equal(1);
		});

		it('a residual byte burst just after a re-arm does not fire without a second evidence window', () => {
			// The race the confirmation window exists for: bytes buffered behind a receive pause (or
			// a suspended peer's kernel send buffer) — e.g. a partial-frame tail — land moments after
			// removePauseReason re-arms the watchdog. That one-window movement is stale residue, not
			// proof of a live peer; it empties within the window and everything after is dark.
			const onSilence = sinon.spy();
			let transportBytes = 500;
			const watchdog = createReceiveWatchdog({
				intervalMs: 60_000,
				getBytesRead: () => 0,
				getTransportActivity: () => transportBytes,
				onSilence,
			});

			watchdog.reset();
			clock.tick(1_000);
			transportBytes += 10; // the buffered tail drains right after the arm, then nothing
			clock.tick(179_000); // three windows: evidence-then-dark must decay, not accumulate
			expect(onSilence.callCount).to.equal(0);
		});

		it('a pending strike is cleared by primary progress, so alternating stall/progress never fires', () => {
			const onSilence = sinon.spy();
			let frames = 0;
			let transportBytes = 500;
			const watchdog = createReceiveWatchdog({
				intervalMs: 60_000,
				getBytesRead: () => frames,
				getTransportActivity: () => transportBytes,
				onSilence,
			});

			watchdog.reset();
			transportBytes += 10;
			clock.tick(60_000); // evidence window → pending strike
			frames += 1;
			transportBytes += 10;
			clock.tick(60_000); // copy progressed → strike cleared
			transportBytes += 10;
			clock.tick(60_000); // evidence again → pending strike only, no fire
			expect(onSilence.callCount).to.equal(0);
		});

		it('an undefined sampler is no evidence: stands down and reports unobservability once', () => {
			// A ws internals change (no _socket) must not recreate the false fire by inferring
			// liveness, and must not silently disable recovery either — the byte watchdog still
			// owns the dark case; this watchdog reports the degraded observability exactly once.
			const onSilence = sinon.spy();
			const onTransportUnobservable = sinon.spy();
			const watchdog = createReceiveWatchdog({
				intervalMs: 60_000,
				getBytesRead: () => 0,
				getTransportActivity: () => undefined,
				onTransportUnobservable,
				onSilence,
			});

			watchdog.reset();
			clock.tick(180_000);
			expect(onSilence.callCount).to.equal(0);
			expect(onTransportUnobservable.callCount).to.equal(1);
		});

		it('a throwing sampler degrades to unobservable instead of crashing the timer callback', () => {
			const onSilence = sinon.spy();
			const onTransportUnobservable = sinon.spy();
			const watchdog = createReceiveWatchdog({
				intervalMs: 60_000,
				getBytesRead: () => 0,
				getTransportActivity: () => {
					throw new Error('socket torn down');
				},
				onTransportUnobservable,
				onSilence,
			});

			watchdog.reset();
			clock.tick(120_000); // the unref'd timer runs the sampler; a throw here would be uncaught
			expect(onSilence.callCount).to.equal(0);
			expect(onTransportUnobservable.callCount).to.equal(1);
		});

		it('a throwing onTransportUnobservable reporter is contained like the sampler', () => {
			const onSilence = sinon.spy();
			const watchdog = createReceiveWatchdog({
				intervalMs: 60_000,
				getBytesRead: () => 0,
				getTransportActivity: () => undefined,
				onTransportUnobservable: () => {
					throw new Error('logger failed during shutdown');
				},
				onSilence,
			});

			watchdog.reset();
			clock.tick(120_000); // the reporter throw would otherwise escape the unref'd timer
			expect(onSilence.callCount).to.equal(0);
		});

		it('a window without a baseline (sampler was unobservable at arm) defers even if bytes now read', () => {
			// Evidence requires a comparison across the window; a baseline that only became
			// observable mid-window cannot prove peer bytes arrived within it. The degraded window
			// is still reported so the extra recovery delay is explicable.
			const onSilence = sinon.spy();
			const onTransportUnobservable = sinon.spy();
			let sampled;
			const watchdog = createReceiveWatchdog({
				intervalMs: 60_000,
				getBytesRead: () => 0,
				getTransportActivity: () => sampled,
				onTransportUnobservable,
				onSilence,
			});

			watchdog.reset(); // baseline unknown
			sampled = 700;
			clock.tick(60_000); // observable now, but no window-spanning evidence → defer, reported
			expect(onSilence.callCount).to.equal(0);
			expect(onTransportUnobservable.callCount).to.equal(1);
			sampled = 710;
			clock.tick(60_000); // baseline established last check; first evidence window → pending strike
			expect(onSilence.callCount).to.equal(0);
			sampled = 720;
			clock.tick(60_000); // confirmation (defaults to intervalMs) with continued movement → fire
			expect(onSilence.callCount).to.equal(1);
		});

		it('confirmIntervalMs bounds the strike confirmation instead of a second full interval', () => {
			const onSilence = sinon.spy();
			let transportBytes = 500;
			const watchdog = createReceiveWatchdog({
				intervalMs: 60_000,
				confirmIntervalMs: 5_000,
				getBytesRead: () => 0,
				getTransportActivity: () => transportBytes,
				onSilence,
			});

			watchdog.reset();
			transportBytes += 10;
			clock.tick(60_000); // evidence window → pending strike, confirmation armed at 5s
			expect(onSilence.callCount).to.equal(0);
			transportBytes += 10;
			clock.tick(5_000); // still moving a ping-cycle later → fire at interval + confirm
			expect(onSilence.callCount).to.equal(1);
		});

		it('a residual strike whose confirmation window is dark decays back to the full interval', () => {
			const onSilence = sinon.spy();
			let transportBytes = 500;
			const watchdog = createReceiveWatchdog({
				intervalMs: 60_000,
				confirmIntervalMs: 5_000,
				getBytesRead: () => 0,
				getTransportActivity: () => transportBytes,
				onSilence,
			});

			watchdog.reset();
			clock.tick(1_000);
			transportBytes += 10; // buffered residue drains right after the arm, then nothing
			clock.tick(59_000); // strike held, confirmation armed
			clock.tick(5_000); // dark confirmation → residue, strike cleared
			clock.tick(120_000); // fully dark thereafter: never fires
			expect(onSilence.callCount).to.equal(0);
		});

		it('throttled resets do not invoke the transport sampler (hot-path cost stays bounded)', () => {
			const onSilence = sinon.spy();
			const getTransportActivity = sinon.spy(() => 500);
			const watchdog = createReceiveWatchdog({
				intervalMs: 60_000,
				getBytesRead: () => 0,
				getTransportActivity,
				onSilence,
			});

			watchdog.reset();
			const samplesAfterArm = getTransportActivity.callCount;
			for (let i = 0; i < 1000; i++) watchdog.reset(); // all within the throttle window
			expect(getTransportActivity.callCount).to.equal(
				samplesAfterArm,
				'throttled resets must not sample transport activity'
			);
		});
	});

	it('regression: silence is still detected when the last activity was a *throttled* reset', () => {
		// PR #234 review bug shape: external reset() while within the throttle window is dropped
		// (no clear+reschedule). The in-flight timer eventually fires, observes that bytesRead
		// has advanced (so it does not call onSilence), and previously did not re-arm — leaving
		// the watchdog permanently dead under exactly the sequence it exists to recover from:
		// peer goes quiet right after a burst, our sendPing tick fails to terminate, no further
		// activity ever triggers reset() again.
		const onSilence = sinon.spy();
		let bytesRead = 0;
		const watchdog = createReceiveWatchdog({
			intervalMs: 60_000,
			getBytesRead: () => bytesRead,
			onSilence,
		});

		watchdog.reset(); // t=0, un-throttled, snapshot = 0, timer fires at t=60s
		clock.tick(500);
		bytesRead = 100;
		watchdog.reset(); // t=500, THROTTLED — snapshot stays at 0, timer still at t=60s

		// Silence from here on (bytesRead frozen at 100).
		// At t=60s the timer fires; bytes changed (0 → 100), so it must re-arm rather than die.
		clock.tick(59_500);
		expect(onSilence.callCount).to.equal(0);

		// The re-armed timer schedules `intervalMs` from when it fired, so it fires at t=120s.
		clock.tick(59_999);
		expect(onSilence.callCount).to.equal(0);
		clock.tick(1);
		expect(onSilence.callCount).to.equal(1);
	});
});
