/**
 * Coverage for `createCopyFlushPacer` — the wall-clock pacer that bounds the gap between socket
 * flushes / event-loop yields during a bulk-table copy. Reading a large cold table dominates copy
 * cost, so a purely record-count-based checkpoint can let a single batch run past the receive
 * watchdog window with no bytes on the wire; the pacer adds a time-based trigger so the connection
 * stays alive. These tests pin the cadence: not due before the interval, due at/after it, and that a
 * `mark()` (from the pacer's own flush OR the count checkpoint, which share the cadence) restarts the
 * window. Clock is injected via `now` args so the cadence is deterministic.
 */

import { expect } from 'chai';
import { createCopyFlushPacer } from '#src/replication/replicationConnection';

describe('createCopyFlushPacer', () => {
	it('is not due before intervalMs has elapsed since the initial anchor', () => {
		const pacer = createCopyFlushPacer(5000, 1000);
		expect(pacer.due(1000)).to.equal(false); // same instant as the anchor
		expect(pacer.due(4999)).to.equal(false); // just under the interval
	});

	it('is due exactly at and beyond intervalMs', () => {
		const pacer = createCopyFlushPacer(5000, 1000);
		expect(pacer.due(6000)).to.equal(true); // exactly intervalMs later
		expect(pacer.due(9999)).to.equal(true); // well past
	});

	it('restarts the window after mark() — defers the next flush by intervalMs', () => {
		const pacer = createCopyFlushPacer(5000, 1000);
		expect(pacer.due(6000)).to.equal(true);
		pacer.mark(6000); // a flush happened at t=6000
		expect(pacer.due(6000)).to.equal(false);
		expect(pacer.due(10999)).to.equal(false); // just under interval from the mark
		expect(pacer.due(11000)).to.equal(true); // interval after the mark
	});

	it('honors a mark from the count-checkpoint path (shared cadence) the same way', () => {
		const pacer = createCopyFlushPacer(5000, 0);
		// count checkpoint flushed at t=3000, well before the time trigger would fire
		pacer.mark(3000);
		expect(pacer.due(7999)).to.equal(false); // time trigger now measured from 3000, not 0
		expect(pacer.due(8000)).to.equal(true);
	});

	it('keeps firing on cadence when mark() is always called on a due flush', () => {
		const pacer = createCopyFlushPacer(1000, 0);
		let fires = 0;
		for (let now = 0; now <= 10_000; now += 250) {
			if (pacer.due(now)) {
				fires++;
				pacer.mark(now);
			}
		}
		// due at 1000, 2000, ... 10000 → 10 flushes; never starves, never double-fires within a window
		expect(fires).to.equal(10);
	});
});
