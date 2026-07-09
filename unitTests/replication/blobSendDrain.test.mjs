/**
 * Coverage for the sender-side graceful blob-send drain (fix (2) of the deploy-reload blob-divergence
 * root cause; harper-pro#527 is the receiver-side fix (1)).
 *
 * A worker restart that tears down an in-flight replication blob SEND mid-stream leaves the peer's copy
 * diverged until it re-requests. Before shutting down, the worker drains sends that are still making
 * progress — bounded by an absolute deadline. The drain decision is a pure function of each send's
 * last-progress timestamp:
 *   - `isSendProgressing`: a send that wrote bytes within the stall window is still worth waiting on.
 *   - `isDrainComplete`: done once the deadline passes, or once NO send is still progressing (all
 *     finished or stalled) — reset-on-bytes, so a healthy transfer that keeps flowing is never
 *     abandoned before the deadline, but a silent one is.
 *
 * The pure helpers are driven with explicit timestamps; `drainBlobSends` is exercised against the live
 * module registry with short real timers.
 */

import { expect } from 'chai';
import {
	isSendProgressing,
	isDrainComplete,
	registerBlobSend,
	noteBlobSendProgress,
	endBlobSend,
	hasActiveBlobSends,
	hasProgressingBlobSends,
	isDrainingBlobSends,
	drainBlobSends,
	_resetBlobSendDrainForTest,
} from '#src/replication/blobSendDrain';

const STALL_MS = 5000;

describe('blobSendDrain pure helpers', () => {
	describe('isSendProgressing', () => {
		it('is progressing when bytes were written within the stall window', () => {
			expect(isSendProgressing(1000, 1000, STALL_MS)).to.equal(true); // just wrote
			expect(isSendProgressing(1000, 5999, STALL_MS)).to.equal(true); // 4999ms ago
		});
		it('is stalled at or beyond the stall window', () => {
			expect(isSendProgressing(1000, 6000, STALL_MS)).to.equal(false); // exactly stallMs ago
			expect(isSendProgressing(1000, 10_000, STALL_MS)).to.equal(false);
		});
	});

	describe('isDrainComplete', () => {
		const now = 100_000;
		const deadline = now + 60_000;

		it('is complete when there are no sends', () => {
			expect(isDrainComplete([], now, STALL_MS, deadline)).to.equal(true);
		});
		it('is complete when every send has stalled', () => {
			const stalled = [now - STALL_MS, now - STALL_MS - 1, now - 60_000];
			expect(isDrainComplete(stalled, now, STALL_MS, deadline)).to.equal(true);
		});
		it('is NOT complete while any send is still progressing', () => {
			const times = [now - 60_000 /* stalled */, now - 10 /* progressing */];
			expect(isDrainComplete(times, now, STALL_MS, deadline)).to.equal(false);
		});
		it('is complete once the deadline has passed, even if a send is still progressing', () => {
			const times = [now]; // actively progressing
			expect(isDrainComplete(times, deadline, STALL_MS, deadline)).to.equal(true); // now === deadline
			expect(isDrainComplete(times, deadline + 1, STALL_MS, deadline)).to.equal(true);
		});
	});
});

describe('blobSendDrain registry + drainBlobSends', () => {
	beforeEach(() => _resetBlobSendDrainForTest());
	afterEach(() => _resetBlobSendDrainForTest());

	it('tracks active sends', () => {
		expect(hasActiveBlobSends()).to.equal(false);
		const token = registerBlobSend();
		expect(hasActiveBlobSends()).to.equal(true);
		endBlobSend(token);
		expect(hasActiveBlobSends()).to.equal(false);
	});

	it('hasProgressingBlobSends only counts sends within the stall window (gates deadline extension)', () => {
		const token = registerBlobSend(); // freshly progressing
		expect(hasProgressingBlobSends(5000)).to.equal(true);
		// A tiny stall window makes even a just-registered send look stalled → no extension.
		expect(hasProgressingBlobSends(0)).to.equal(false);
		endBlobSend(token);
		expect(hasProgressingBlobSends(5000)).to.equal(false); // no sends at all
	});

	it('drainBlobSends quiesces: sets the draining flag so no new sends are started', async () => {
		expect(isDrainingBlobSends()).to.equal(false);
		await drainBlobSends(Date.now() + 10_000, 5000, 10); // no active sends → resolves immediately
		expect(isDrainingBlobSends()).to.equal(true);
	});

	it('resolves immediately when there are no sends', async () => {
		const start = Date.now();
		await drainBlobSends(start + 10_000, STALL_MS, 10);
		expect(Date.now() - start).to.be.lessThan(200);
	});

	it('waits for a progressing send, then resolves once it ends', async () => {
		const token = registerBlobSend();
		// Keep it progressing across a couple of poll intervals, then end it.
		const keepAlive = setInterval(() => noteBlobSendProgress(token), 20);
		const drained = drainBlobSends(Date.now() + 10_000, 200 /* stallMs */, 10 /* pollMs */);
		let resolvedEarly = false;
		drained.then(() => (resolvedEarly = true));
		await new Promise((r) => setTimeout(r, 120));
		expect(resolvedEarly).to.equal(false); // still progressing → not drained
		clearInterval(keepAlive);
		endBlobSend(token);
		await drained; // resolves promptly after the send ends
	});

	it('stops waiting on a send that stalls (no bytes for the stall window)', async () => {
		registerBlobSend(); // registered, never marked progressing again
		const start = Date.now();
		await drainBlobSends(start + 10_000, 100 /* stallMs */, 10 /* pollMs */);
		const elapsed = Date.now() - start;
		expect(elapsed).to.be.greaterThanOrEqual(80); // waited ~the stall window (margin for timer jitter)
		expect(elapsed).to.be.lessThan(2000); // but not the full deadline
	});

	it('resolves at the deadline even if the send keeps progressing', async () => {
		const token = registerBlobSend();
		const keepAlive = setInterval(() => noteBlobSendProgress(token), 10);
		const start = Date.now();
		await drainBlobSends(start + 150 /* deadline */, 5000 /* stallMs: never stalls */, 10);
		const elapsed = Date.now() - start;
		clearInterval(keepAlive);
		endBlobSend(token);
		expect(elapsed).to.be.greaterThanOrEqual(120); // margin for timer jitter
		expect(elapsed).to.be.lessThan(2000);
	});
});
