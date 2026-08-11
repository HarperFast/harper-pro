/**
 * Coverage for `createBlobGapReconnectTimer` (harper-pro#683).
 *
 * Background: `hasBlobGap` latches on the first transient blob-save failure and nothing in the
 * connection's lifetime clears it — the latch pins the durable resume cursor, blocks
 * `flushDurableCopyCursor`, and prevents `maybeFinishCopy` from ever exiting copy mode. Only a
 * reconnect (fresh connection state) re-streams the gapped blob and heals it, but a gapped
 * connection keeps flowing frames and answering pings, so no byte/frame watchdog ever notices it;
 * in the field a link sat latched for ~3.7h until an UNRELATED reconnect resumed a whole-table
 * base copy. This timer bounds that state: armed at the first latch, it forces the healing
 * reconnect after `timeoutMs` if none happened on its own.
 *
 * These tests pin the contract the production wiring depends on: arm-idempotence (repeat arms
 * don't restart or stack the deadline), re-arming after each fire (`forceReconnect()` can be a
 * no-op when a retry was already scheduled and later abandoned, so a one-shot fire could leave the
 * wedge unbounded again — the timer must keep firing every timeoutMs until the connection closes),
 * and stop() cancelling cleanly on connection close.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { createBlobGapReconnectTimer } from '#src/replication/replicationConnection';

describe('createBlobGapReconnectTimer (#683)', () => {
	let clock;

	beforeEach(() => {
		clock = sinon.useFakeTimers();
	});

	afterEach(() => {
		clock.restore();
	});

	it('fires onGapHeld exactly at timeoutMs after arm()', () => {
		const onGapHeld = sinon.spy();
		const timer = createBlobGapReconnectTimer({ timeoutMs: 900_000, onGapHeld });
		expect(timer.isArmed()).to.equal(false);

		timer.arm();
		expect(timer.isArmed()).to.equal(true);

		clock.tick(899_999);
		expect(onGapHeld.callCount).to.equal(0);

		clock.tick(1);
		expect(onGapHeld.callCount).to.equal(1);
	});

	it('re-arms after each fire — keeps firing every timeoutMs while the gap stays held', () => {
		const onGapHeld = sinon.spy();
		const timer = createBlobGapReconnectTimer({ timeoutMs: 900_000, onGapHeld });

		timer.arm();
		clock.tick(900_000);
		expect(onGapHeld.callCount).to.equal(1);
		expect(timer.isArmed()).to.equal(true); // still armed for the next cycle

		clock.tick(900_000);
		expect(onGapHeld.callCount).to.equal(2);
		clock.tick(1_800_000);
		expect(onGapHeld.callCount).to.equal(4);
	});

	it('a synchronous stop() from inside onGapHeld cancels the re-arm (the reconnect close path)', () => {
		let timer;
		const onGapHeld = sinon.spy(() => timer.stop());
		timer = createBlobGapReconnectTimer({ timeoutMs: 1000, onGapHeld });

		timer.arm();
		clock.tick(1000);
		expect(onGapHeld.callCount).to.equal(1);
		expect(timer.isArmed()).to.equal(false);
		clock.tick(10_000);
		expect(onGapHeld.callCount).to.equal(1);
	});

	it('is idempotent while armed — repeat arms do not restart or stack the timer', () => {
		const onGapHeld = sinon.spy();
		const timer = createBlobGapReconnectTimer({ timeoutMs: 1000, onGapHeld });

		timer.arm();
		clock.tick(900);
		timer.arm(); // a second blob fault latches nothing new; deadline must not slide
		clock.tick(100);
		expect(onGapHeld.callCount).to.equal(1);
		clock.tick(999);
		expect(onGapHeld.callCount).to.equal(1); // no stacked second timer firing early
		clock.tick(1);
		expect(onGapHeld.callCount).to.equal(2); // just the re-arm, exactly one period later
	});

	it('stop() cancels a pending fire (connection close)', () => {
		const onGapHeld = sinon.spy();
		const timer = createBlobGapReconnectTimer({ timeoutMs: 1000, onGapHeld });

		timer.arm();
		clock.tick(999);
		timer.stop();
		expect(timer.isArmed()).to.equal(false);
		clock.tick(10_000);
		expect(onGapHeld.callCount).to.equal(0);
	});

	it('stop() before arm() and repeated stop() are safe no-ops', () => {
		const onGapHeld = sinon.spy();
		const timer = createBlobGapReconnectTimer({ timeoutMs: 1000, onGapHeld });
		timer.stop();
		timer.stop();
		timer.arm();
		timer.stop();
		timer.stop();
		clock.tick(10_000);
		expect(onGapHeld.callCount).to.equal(0);
	});

	it('can be re-armed after stop() (stop is a cancel, not a latch)', () => {
		const onGapHeld = sinon.spy();
		const timer = createBlobGapReconnectTimer({ timeoutMs: 1000, onGapHeld });
		timer.arm();
		timer.stop();
		timer.arm();
		clock.tick(1000);
		expect(onGapHeld.callCount).to.equal(1);
	});
});
