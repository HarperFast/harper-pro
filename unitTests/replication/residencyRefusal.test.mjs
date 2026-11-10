/**
 * An owner's refusal of this node's stream, as the write guard reads it (harper-pro#1278): set when the owner closes
 * a sender's stream refusing it, cleared when a sender of that or a later generation starts replaying, and never set
 * again by an earlier sender whose close lands after its replacement replays.
 */
import assert from 'node:assert';
import { registerResidencySender, residencyOwnerRefusing } from '#src/replication/residencyTopology';

function fakeStore() {
	const buffers = new Map();
	return {
		getUserSharedBuffer(key, initial) {
			const name = JSON.stringify(key);
			if (!buffers.has(name)) buffers.set(name, initial);
			return buffers.get(name);
		},
	};
}

describe('residency owner refusal', () => {
	it('is set by a refusal, reported once, kept across close, and cleared by the next replay', () => {
		const store = fakeStore();
		const first = registerResidencySender(store, 'data', 'owner');
		assert.strictEqual(residencyOwnerRefusing(store, 'data', 'owner'), false);
		assert.strictEqual(first.refused(), true);
		first.close();
		assert.strictEqual(residencyOwnerRefusing(store, 'data', 'owner'), true);
		const second = registerResidencySender(store, 'data', 'owner');
		assert.strictEqual(second.refused(), false, 'a refusal already recorded is not reported again');
		second.close();
		const third = registerResidencySender(store, 'data', 'owner');
		third.replaying();
		assert.strictEqual(residencyOwnerRefusing(store, 'data', 'owner'), false);
	});

	it("ignores an earlier sender's refusal that lands after a later sender replays", () => {
		const store = fakeStore();
		const earlier = registerResidencySender(store, 'data', 'owner');
		const later = registerResidencySender(store, 'data', 'owner');
		later.replaying();
		assert.strictEqual(earlier.refused(), false);
		assert.strictEqual(residencyOwnerRefusing(store, 'data', 'owner'), false);
	});

	it("keeps a later sender's refusal when an earlier sender replays", () => {
		const store = fakeStore();
		const earlier = registerResidencySender(store, 'data', 'owner');
		const later = registerResidencySender(store, 'data', 'owner');
		assert.strictEqual(later.refused(), true);
		earlier.replaying();
		assert.strictEqual(residencyOwnerRefusing(store, 'data', 'owner'), true);
	});

	it('is kept per database and peer', () => {
		const store = fakeStore();
		registerResidencySender(store, 'data', 'owner').refused();
		assert.strictEqual(residencyOwnerRefusing(store, 'data', 'owner'), true);
		assert.strictEqual(residencyOwnerRefusing(store, 'data', 'other-owner'), false);
		assert.strictEqual(residencyOwnerRefusing(store, 'other', 'owner'), false);
	});
});
