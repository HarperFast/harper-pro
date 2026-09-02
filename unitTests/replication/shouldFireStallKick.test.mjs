/**
 * The receive-stall kick is armed under `entry.receiveStallReconnectAt`, which is both its claim on the
 * entry and the throttle that gates re-detection (`findStalledReceivingNodeUrls` needs `lastReceivedTime`
 * past the stamp). A skip therefore has to say whether the epoch was really spent, or a kick that never
 * fired can retire the net for that (peer, database) permanently.
 */

import assert from 'node:assert';
import { shouldFireStallKick } from '#src/replication/subscriptionManager';

const ARMED_AT = 1_000;

function makeEntry(overrides = {}) {
	return { receiveStallReconnectAt: ARMED_AT, connectGeneration: 3, ...overrides };
}

function verdict(entry, overrides = {}) {
	return shouldFireStallKick({
		current: entry,
		armed: entry,
		armedAt: ARMED_AT,
		armedGeneration: 3,
		stalledAtWatermark: 500,
		currentWatermark: 500,
		...overrides,
	});
}

describe('shouldFireStallKick', () => {
	it('fires when the entry is unchanged and no data has arrived', () => {
		assert.deepEqual(verdict(makeEntry()), { fire: true, releaseThrottle: false });
	});

	it('does not fire for a superseded entry, and does not release a stamp it does not own', () => {
		const entry = makeEntry();
		assert.deepEqual(verdict(entry, { current: makeEntry() }), { fire: false, releaseThrottle: false });
	});

	it('does not fire once a newer reconcile re-stamped the throttle', () => {
		assert.deepEqual(verdict(makeEntry({ receiveStallReconnectAt: 2000 })), { fire: false, releaseThrottle: false });
	});

	it('does not fire for an entry that has since unsubscribed', () => {
		assert.deepEqual(verdict(makeEntry({ unsubscribed: true })), { fire: false, releaseThrottle: false });
	});

	// The regression: skipping on a reconnect used to keep the stamp, and a fresh socket that also stalls
	// never moves lastReceivedTime past it — so the net never re-armed for that pair again.
	it('releases the throttle when the leg reconnected inside the stagger window', () => {
		assert.deepEqual(verdict(makeEntry({ connectGeneration: 4 })), { fire: false, releaseThrottle: true });
	});

	it('treats a missing connectGeneration as generation 0', () => {
		const entry = { receiveStallReconnectAt: ARMED_AT };
		assert.deepEqual(verdict(entry, { armedGeneration: 0 }), { fire: true, releaseThrottle: false });
		assert.deepEqual(verdict(entry, { armedGeneration: 1 }), { fire: false, releaseThrottle: true });
	});

	// Progress means the stall resolved on its own: no kick is owed and the stamp correctly records the
	// epoch, so it must NOT be released.
	it('does not fire, or release, when the watermark advanced', () => {
		assert.deepEqual(verdict(makeEntry(), { currentWatermark: 900 }), { fire: false, releaseThrottle: false });
	});

	it('fires when either watermark is unavailable', () => {
		assert.deepEqual(verdict(makeEntry(), { currentWatermark: undefined }), { fire: true, releaseThrottle: false });
		assert.deepEqual(verdict(makeEntry(), { stalledAtWatermark: undefined }), { fire: true, releaseThrottle: false });
	});
});
