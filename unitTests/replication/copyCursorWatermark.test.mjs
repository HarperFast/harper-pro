/**
 * Coverage for `CopyCursorWatermark` (harper-pro#699).
 *
 * The bulk-copy resume cursor may only be persisted once every blob received for frames at or
 * before it is durably saved. The watermark orders committed frames against in-flight and gapped
 * blobs by walk position, so a transient blob fault at frame G clamps persistence only from G
 * onward — everything staged before G stays eligible and banks (#699).
 *
 * These tests pin the contract the production wiring depends on: eligibility ordering against
 * unsettled and gapped blobs, barrier monotonicity (minimum wins, never heals in-connection),
 * pass supersession (staged cursors from a replaced COPY_START pass never surface), bounded state
 * under a held barrier, and the non-throwing/idempotent behavior of every method (callers run
 * from promise `.finally` chains and commit hooks where a throw would reject process-owned
 * chains).
 */

import { expect } from 'chai';
import { CopyCursorWatermark } from '#src/replication/copyCursorWatermark';

const cursor = (afterKey) => ({ copyStartTime: 1, currentTable: 't', afterKey, copyOrder: 1 });

describe('CopyCursorWatermark (#699)', () => {
	let watermark;
	let pass;

	beforeEach(() => {
		watermark = new CopyCursorWatermark();
		pass = watermark.currentPass;
	});

	it('returns the highest staged cursor when nothing blocks', () => {
		const f1 = watermark.beginFrame();
		const f2 = watermark.beginFrame();
		watermark.stageCursor(f1, pass, cursor('a'));
		watermark.stageCursor(f2, pass, cursor('b'));
		expect(watermark.takeDurable().afterKey).to.equal('b');
		expect(watermark.takeDurable()).to.equal(null);
		expect(watermark.isDrained).to.equal(true);
	});

	it('holds staged cursors at and after an unsettled blob, releases on settle', () => {
		const f1 = watermark.beginFrame();
		const f2 = watermark.beginFrame();
		const f3 = watermark.beginFrame();
		watermark.trackBlob(f2);
		watermark.stageCursor(f1, pass, cursor('a'));
		watermark.stageCursor(f2, pass, cursor('b'));
		watermark.stageCursor(f3, pass, cursor('c'));
		expect(watermark.takeDurable().afterKey).to.equal('a');
		expect(watermark.takeDurable()).to.equal(null);
		watermark.settleBlob(f2, false);
		expect(watermark.takeDurable().afterKey).to.equal('c');
	});

	it('requires ALL blobs of a frame to settle (multiple blobs per frame)', () => {
		const f1 = watermark.beginFrame();
		watermark.trackBlob(f1);
		watermark.trackBlob(f1);
		watermark.stageCursor(f1, pass, cursor('a'));
		watermark.settleBlob(f1, false);
		expect(watermark.takeDurable()).to.equal(null);
		watermark.settleBlob(f1, false);
		expect(watermark.takeDurable().afterKey).to.equal('a');
	});

	it('handles out-of-order settlement across frames', () => {
		const f1 = watermark.beginFrame();
		const f2 = watermark.beginFrame();
		watermark.trackBlob(f1);
		watermark.trackBlob(f2);
		watermark.stageCursor(f1, pass, cursor('a'));
		watermark.stageCursor(f2, pass, cursor('b'));
		watermark.settleBlob(f2, false); // later frame settles first
		expect(watermark.takeDurable()).to.equal(null); // f1 still unsettled blocks everything
		watermark.settleBlob(f1, false);
		expect(watermark.takeDurable().afterKey).to.equal('b');
	});

	it('a gapped blob clamps its own frame onward but banks the prefix', () => {
		const f1 = watermark.beginFrame();
		const f2 = watermark.beginFrame();
		const f3 = watermark.beginFrame();
		watermark.trackBlob(f2);
		watermark.stageCursor(f1, pass, cursor('a'));
		watermark.stageCursor(f2, pass, cursor('b'));
		watermark.stageCursor(f3, pass, cursor('c'));
		watermark.settleBlob(f2, true);
		expect(watermark.hasBarrier).to.equal(true);
		expect(watermark.takeDurable().afterKey).to.equal('a'); // prefix banks
		expect(watermark.takeDurable()).to.equal(null); // f2/f3 never eligible again
		expect(watermark.isDrained).to.equal(true); // clamped entries were consumed/dropped, not retained
	});

	it('waits for earlier in-flight blobs before releasing the pre-gap prefix', () => {
		const f1 = watermark.beginFrame();
		const f2 = watermark.beginFrame();
		watermark.trackBlob(f1);
		watermark.trackBlob(f2);
		watermark.stageCursor(f1, pass, cursor('a'));
		watermark.stageCursor(f2, pass, cursor('b'));
		watermark.settleBlob(f2, true); // gap at f2 while f1 still in flight
		expect(watermark.takeDurable()).to.equal(null); // f1 could still fail and lower the barrier
		watermark.settleBlob(f1, false);
		expect(watermark.takeDurable().afterKey).to.equal('a');
	});

	it('barrier is a minimum and never rises', () => {
		const f1 = watermark.beginFrame();
		const f2 = watermark.beginFrame();
		const f3 = watermark.beginFrame();
		watermark.trackBlob(f1);
		watermark.trackBlob(f3);
		watermark.settleBlob(f3, true);
		watermark.settleBlob(f1, true); // lower gap wins
		watermark.stageCursor(f1, pass, cursor('a'));
		watermark.stageCursor(f2, pass, cursor('b'));
		expect(watermark.takeDurable()).to.equal(null); // nothing below frame 1 exists
	});

	it('an unrecoverable-source blob settles un-gapped and the cursor advances past it (#403)', () => {
		const f1 = watermark.beginFrame();
		watermark.trackBlob(f1);
		watermark.stageCursor(f1, pass, cursor('a'));
		watermark.settleBlob(f1, false);
		expect(watermark.takeDurable().afterKey).to.equal('a');
		expect(watermark.hasBarrier).to.equal(false);
	});

	it('drops stagings from a superseded pass and staged state on beginPass', () => {
		const f1 = watermark.beginFrame();
		watermark.stageCursor(f1, pass, cursor('a')); // staged but not yet taken
		const newPass = watermark.beginPass();
		expect(watermark.takeDurable()).to.equal(null); // prior pass's staging is gone
		watermark.stageCursor(watermark.beginFrame(), pass, cursor('stale')); // stale pass id
		expect(watermark.takeDurable()).to.equal(null);
		const f3 = watermark.beginFrame();
		watermark.stageCursor(f3, newPass, cursor('fresh'));
		expect(watermark.takeDurable().afterKey).to.equal('fresh');
	});

	it('keeps the barrier latched across passes (the reconnect is the healer)', () => {
		const f1 = watermark.beginFrame();
		watermark.trackBlob(f1);
		watermark.settleBlob(f1, true);
		const newPass = watermark.beginPass();
		expect(watermark.hasBarrier).to.equal(true);
		const f2 = watermark.beginFrame();
		watermark.stageCursor(f2, newPass, cursor('a'));
		expect(watermark.takeDurable()).to.equal(null);
	});

	it('holds bounded state under a held barrier (post-barrier work is dropped, not retained)', () => {
		const f1 = watermark.beginFrame();
		watermark.trackBlob(f1);
		watermark.settleBlob(f1, true);
		for (let i = 0; i < 10000; i++) {
			const f = watermark.beginFrame();
			watermark.trackBlob(f); // skipped: at/past barrier
			watermark.stageCursor(f, pass, cursor(i)); // dropped: at/past barrier
		}
		expect(watermark.isDrained).to.equal(true);
		expect(watermark.takeDurable()).to.equal(null);
	});

	it('keeps the minimum-tag invariant when blob tags arrive out of ascending order', () => {
		// Frames decode serially so tags normally ascend; trackBlob defends the head-is-minimum
		// invariant anyway, because a wrong head would let takeDurable release a cursor past an
		// unsettled blob (the silent divergence #368/#386 exist to prevent).
		const f1 = watermark.beginFrame();
		const f2 = watermark.beginFrame();
		const f3 = watermark.beginFrame();
		watermark.trackBlob(f3);
		watermark.trackBlob(f1); // out of order: lower tag arrives after a higher one
		watermark.trackBlob(f2);
		watermark.stageCursor(f1, pass, cursor('a'));
		watermark.stageCursor(f2, pass, cursor('b'));
		watermark.stageCursor(f3, pass, cursor('c'));
		expect(watermark.takeDurable()).to.equal(null); // f1 must be the limit, not f3
		watermark.settleBlob(f1, false);
		expect(watermark.takeDurable().afterKey).to.equal('a'); // limit moved to f2, releasing only f1
		watermark.settleBlob(f2, false);
		expect(watermark.takeDurable().afterKey).to.equal('b'); // limit moved to f3
		watermark.settleBlob(f3, false);
		expect(watermark.takeDurable().afterKey).to.equal('c');
	});

	it('caps retained staged state at unsettled tags + 1 while a low blob hangs', () => {
		const f1 = watermark.beginFrame();
		watermark.trackBlob(f1); // hung: never settles during the walk
		watermark.stageCursor(f1, pass, cursor(1));
		for (let i = 0; i < 10000; i++) {
			const f = watermark.beginFrame();
			watermark.stageCursor(f, pass, cursor(f));
			expect(watermark.takeDurable()).to.equal(null); // blocked behind the hung blob
		}
		expect(watermark.stagedCount).to.be.at.most(2);
		watermark.settleBlob(f1, false);
		expect(watermark.takeDurable().afterKey).to.equal(10001); // latest cursor survives the collapse
	});

	it('keeps the bound when separators settle after staging (hung low tag + settling walk)', () => {
		const f1 = watermark.beginFrame();
		watermark.trackBlob(f1); // hung low blob pins takeDurable's limit for the whole loop
		watermark.stageCursor(f1, pass, cursor(1));
		for (let i = 0; i < 5000; i++) {
			const f = watermark.beginFrame();
			watermark.trackBlob(f); // separator at stage time...
			watermark.stageCursor(f, pass, cursor(f));
			watermark.settleBlob(f, false); // ...settles right after — entries must re-merge
			expect(watermark.takeDurable()).to.equal(null);
			expect(watermark.stagedCount).to.be.at.most(3); // hung-tag span + the live tail
		}
		watermark.settleBlob(f1, false);
		expect(watermark.takeDurable().afterKey).to.equal(5001);
	});

	it('barrierDrained flips only when no unsettled blob remains below the barrier', () => {
		const f1 = watermark.beginFrame();
		const f2 = watermark.beginFrame();
		watermark.trackBlob(f1);
		watermark.trackBlob(f2);
		watermark.settleBlob(f2, true);
		expect(watermark.hasBarrier).to.equal(true);
		expect(watermark.barrierDrained).to.equal(false); // f1 could still fail and lower the barrier
		watermark.settleBlob(f1, false);
		expect(watermark.barrierDrained).to.equal(true);
	});

	it('is idempotent and non-throwing on duplicate, unknown, and undefined settles', () => {
		const f1 = watermark.beginFrame();
		watermark.trackBlob(f1);
		watermark.stageCursor(f1, pass, cursor('a'));
		watermark.settleBlob(f1, false);
		watermark.settleBlob(f1, false); // duplicate
		watermark.settleBlob(999, false); // unknown
		watermark.settleBlob(undefined, true); // untracked/non-copy blob: no-op, no barrier
		watermark.trackBlob(undefined);
		watermark.stageCursor(undefined, pass, cursor('x'));
		expect(watermark.hasBarrier).to.equal(false);
		expect(watermark.takeDurable().afterKey).to.equal('a');
	});

	it('streams thousands of frames with interleaved blob drains and banks continuously', () => {
		let banked = null;
		for (let i = 0; i < 5000; i++) {
			const f = watermark.beginFrame();
			if (i % 3 === 0) watermark.trackBlob(f);
			watermark.stageCursor(f, pass, cursor(i));
			if (i % 3 === 0) watermark.settleBlob(f, false);
			const taken = watermark.takeDurable();
			if (taken) banked = taken;
		}
		expect(banked.afterKey).to.be.greaterThan(4990);
	});
});
