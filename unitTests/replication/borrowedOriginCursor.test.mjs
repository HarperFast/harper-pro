import assert from 'node:assert';
import { borrowedOriginCursor, cursorBelowFloor } from '#src/replication/replicationConnection';

describe('borrowedOriginCursor (harper-pro#1291 supplier switch)', () => {
	it("takes the relieved supplier's position when no floor is certified", () => {
		assert.strictEqual(borrowedOriginCursor({ id: 4, originLogKey: 5000 }, undefined), 5000);
	});

	it('takes the higher of the certified floor and the relieved position', () => {
		const qualified = { floor: 9000, generation: 'g1' };
		assert.strictEqual(
			borrowedOriginCursor({ id: 4, originLogKey: 5000, originGeneration: 'g1' }, qualified),
			cursorBelowFloor(9000)
		);
		assert.strictEqual(borrowedOriginCursor({ id: 4, originLogKey: 12000, originGeneration: 'g1' }, qualified), 12000);
	});

	it('ignores a relieved state that is revoked, holed, partial, invalid, or of another generation', () => {
		const qualified = { floor: 9000, generation: 'g1' };
		for (const state of [
			{ originLogKey: 12000, originGeneration: 'g1', floorRevoked: true },
			{ originLogKey: 12000, originGeneration: 'g1', hole: true },
			{ originLogKey: 12000, originGeneration: 'g1', partialHistory: true },
			{ originLogKey: 'x', originGeneration: 'g1' },
			{ originLogKey: 12000, originGeneration: 'g0' },
		]) {
			assert.strictEqual(borrowedOriginCursor(state, qualified), cursorBelowFloor(9000), JSON.stringify(state));
		}
		assert.strictEqual(borrowedOriginCursor({ originLogKey: 12000, hole: true }, undefined), undefined);
	});

	it('decides by generation: equal borrows, different takes the floor, unknown still borrows', () => {
		const qualified = { floor: 9000, generation: 'g1' };
		assert.strictEqual(borrowedOriginCursor({ originLogKey: 12000, originGeneration: 'g1' }, qualified), 12000);
		assert.strictEqual(
			borrowedOriginCursor({ originLogKey: 12000, originGeneration: 'g0' }, qualified),
			cursorBelowFloor(9000)
		);
		assert.strictEqual(borrowedOriginCursor({ originLogKey: 12000 }, qualified), 12000);
		assert.strictEqual(borrowedOriginCursor({ originLogKey: 12000, lastGeneration: 'g1' }, qualified), 12000);
		// no floor names the current generation, and nothing records where it began, so the position stands
		assert.strictEqual(borrowedOriginCursor({ originLogKey: 12000, originGeneration: 'g0' }, undefined), 12000);
	});

	it('has no cursor with neither source', () => {
		assert.strictEqual(borrowedOriginCursor(undefined, undefined), undefined);
	});
});
