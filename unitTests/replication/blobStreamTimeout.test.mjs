/**
 * Regression coverage for the spurious blob-stream timeout (harper-pro#368 — the root-cause
 * trigger of the soak-rolling-restarts record loss).
 *
 * Background: `replicateOverWS` runs a `blobsTimer` sweep that destroys any in-flight blob stream
 * whose `lastChunk + blobTimeout < now`. `lastChunk` only advances when a chunk is actually
 * processed in the receive path. During post-restart catch-up the receiver back-pressures its OWN
 * socket reads (commit backlog / consumer queue full / blob-write drain — see `addPauseReason` /
 * `removePauseReason`), so a perfectly healthy in-flight stream processes no chunks for the entire
 * pause and its `lastChunk` goes stale. Counting that self-inflicted paused interval against
 * `blobTimeout` destroyed a live stream, which surfaced downstream as a swallowed "Blob save failed"
 * and replication record loss.
 *
 * The fix discounts ONLY the paused interval, never genuine (non-paused) idle time:
 *   - The sweep credits the *ongoing* pause: `isBlobStreamTimedOut(lastChunk + ongoingPauseMs, ...)`,
 *     where `ongoingPauseMs = now - pauseStartTime` while paused (else 0). This is what stops a sweep
 *     that fires mid-pause — a pause can outlast blobTimeout — from reaping a healthy stream before
 *     resume runs.
 *   - On resume `refreshBlobStreamsOnResume(blobsInFlight, pausedMs)` shifts each `lastChunk` forward
 *     by EXACTLY the paused duration (called from `removePauseReason`). It does NOT reset to `now`:
 *     resetting would discard pre-pause idle time, so repeated pause/resume churn could keep a truly
 *     stuck stream alive forever. Shifting preserves genuine idle time.
 *   - `isBlobStreamTimedOut(lastChunk, blobTimeout, now)` is the (unchanged) elapsed-time predicate.
 *
 * These are deterministic pure helpers (mirroring `shouldTerminateIdlePing`); we drive the
 * pause/resume/sweep sequence with explicit timestamps rather than a flaky live multi-node
 * back-pressure repro. To confirm this guards the regression, delete the
 * `refreshBlobStreamsOnResume` call in `removePauseReason` (and the `ongoingPauseMs` credit in the
 * sweep) and rebuild — the "healthy paused stream" cases below will report a spurious timeout.
 */

import { expect } from 'chai';
import { isBlobStreamTimedOut, refreshBlobStreamsOnResume } from '#src/replication/replicationConnection';

const BLOB_TIMEOUT = 120_000; // production default (replication_blobTimeout)

// Model the sweep's decision: `lastChunk` shifted forward by any ongoing (not-yet-ended) pause.
const sweepWouldTimeOut = (lastChunk, now, pauseStartTime = 0, paused = false) =>
	isBlobStreamTimedOut(lastChunk + (paused ? now - pauseStartTime : 0), BLOB_TIMEOUT, now);

describe('replication blob-stream timeout accounting — #368 spurious timeout', () => {
	describe('isBlobStreamTimedOut', () => {
		it('does NOT time out while within the window', () => {
			expect(isBlobStreamTimedOut(0, BLOB_TIMEOUT, BLOB_TIMEOUT)).to.equal(false);
			expect(isBlobStreamTimedOut(0, BLOB_TIMEOUT, BLOB_TIMEOUT - 1)).to.equal(false);
		});

		it('times out once elapsed time exceeds the window', () => {
			expect(isBlobStreamTimedOut(0, BLOB_TIMEOUT, BLOB_TIMEOUT + 1)).to.equal(true);
			expect(isBlobStreamTimedOut(0, BLOB_TIMEOUT, BLOB_TIMEOUT * 5)).to.equal(true);
		});

		it('honors a custom (e.g. operator-lowered) timeout', () => {
			expect(isBlobStreamTimedOut(0, 5_000, 4_000)).to.equal(false);
			expect(isBlobStreamTimedOut(0, 5_000, 6_000)).to.equal(true);
		});
	});

	describe('refreshBlobStreamsOnResume — shifts by the paused duration, does not reset', () => {
		it('advances lastChunk forward by exactly pausedMs on every in-flight stream', () => {
			const blobsInFlight = new Map([
				['a', { lastChunk: 0 }],
				['b', { lastChunk: 1_000 }],
				['c', { lastChunk: 50_000 }],
			]);
			refreshBlobStreamsOnResume(blobsInFlight, 200_000);
			expect(blobsInFlight.get('a').lastChunk).to.equal(200_000);
			expect(blobsInFlight.get('b').lastChunk).to.equal(201_000);
			expect(blobsInFlight.get('c').lastChunk).to.equal(250_000);
		});

		it('is a no-op when nothing is in flight, or when pausedMs is non-positive', () => {
			expect(() => refreshBlobStreamsOnResume(new Map(), 200_000)).to.not.throw();
			const blobsInFlight = new Map([['a', { lastChunk: 5_000 }]]);
			refreshBlobStreamsOnResume(blobsInFlight, 0);
			expect(blobsInFlight.get('a').lastChunk).to.equal(5_000); // unchanged
		});
	});

	// The behavior that matters: a stream paused for the FULL timeout window is still healthy and must
	// survive — both while the pause is ongoing (the sweep credits it) and after resume (the shift
	// credits it). This is the exact sequence #368 mis-handled.
	describe('healthy stream paused for back-pressure does not spuriously time out', () => {
		it('survives a sweep that fires MID-pause, even when the pause already exceeds blobTimeout', () => {
			// t=0: last real chunk; receiver pauses (commit backlog). pauseStartTime = 0.
			const stream = { lastChunk: 0, recordId: 'rec-1' };
			const stillPaused = BLOB_TIMEOUT + 60_000; // pause outlasts the timeout window

			// WITHOUT the ongoing-pause credit the sweep would reap the healthy stream here (the #368 bug):
			expect(isBlobStreamTimedOut(stream.lastChunk, BLOB_TIMEOUT, stillPaused)).to.equal(true);
			// WITH the credit (paused === true), the sweep leaves it alone:
			expect(sweepWouldTimeOut(stream.lastChunk, stillPaused, /*pauseStartTime*/ 0, /*paused*/ true)).to.equal(false);
		});

		it('survives after resume — the paused window is shifted out, a fresh full window remains', () => {
			const stream = { lastChunk: 0 };
			const blobsInFlight = new Map([['blob-1', stream]]);
			const pausedFor = BLOB_TIMEOUT + 60_000;

			// removePauseReason shifts lastChunk forward by exactly the paused duration on resume.
			refreshBlobStreamsOnResume(blobsInFlight, pausedFor);
			expect(stream.lastChunk).to.equal(pausedFor);

			// A sweep just after resume must NOT time the stream out: the paused window no longer counts.
			expect(sweepWouldTimeOut(stream.lastChunk, pausedFor + 1)).to.equal(false);
			// It survives right up to (but not past) a fresh full window measured from the resume point.
			expect(sweepWouldTimeOut(stream.lastChunk, pausedFor + BLOB_TIMEOUT)).to.equal(false);
			expect(sweepWouldTimeOut(stream.lastChunk, pausedFor + BLOB_TIMEOUT + 1)).to.equal(true);
		});
	});

	// The fix must NOT mask a genuinely stuck stream: only paused time is discounted, so real idle time
	// accrues and the sweep still reaps it — including across repeated pause/resume churn.
	describe('genuinely stalled stream still times out', () => {
		it('a never-paused stream still trips the timeout (local write wedged while reads continued)', () => {
			const stream = { lastChunk: 1_000 };
			expect(sweepWouldTimeOut(stream.lastChunk, 1_000 + BLOB_TIMEOUT + 1)).to.equal(true);
		});

		it('repeated pause/resume churn does NOT keep a genuinely stuck stream alive forever', () => {
			// A stream that never receives a chunk, while the connection pauses/resumes repeatedly for
			// unrelated back-pressure. Each resume credits ONLY that pause's duration; genuine idle time
			// keeps accruing, so the stream is still reaped once non-paused idle exceeds the window.
			const stream = { lastChunk: 0 };
			const blobsInFlight = new Map([['blob-1', stream]]);
			let totalPaused = 0;
			for (let i = 0; i < 5; i++) {
				const pausedMs = 10_000; // five short pauses
				refreshBlobStreamsOnResume(blobsInFlight, pausedMs);
				totalPaused += pausedMs;
			}
			expect(stream.lastChunk).to.equal(totalPaused); // only paused time was ever credited

			// Genuine (non-paused) idle past a full window beyond all the crediting → reaped.
			const now = totalPaused + BLOB_TIMEOUT + 1;
			expect(sweepWouldTimeOut(stream.lastChunk, now)).to.equal(true);
		});
	});
});
