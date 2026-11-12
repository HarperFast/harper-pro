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

	it('takes the floor the relieved supplier certified, alone or when it is above the position', () => {
		assert.strictEqual(borrowedOriginCursor({ id: 4, closedFloor: 7000 }, undefined), cursorBelowFloor(7000));
		assert.strictEqual(
			borrowedOriginCursor({ id: 4, closedFloor: 7000, originLogKey: 5000 }, undefined),
			cursorBelowFloor(7000)
		);
		assert.strictEqual(borrowedOriginCursor({ id: 4, closedFloor: 7000, originLogKey: 8000 }, undefined), 8000);
		for (const flag of ['floorRevoked', 'hole', 'partialHistory'])
			assert.strictEqual(borrowedOriginCursor({ id: 4, closedFloor: 7000, [flag]: true }, undefined), undefined, flag);
		assert.strictEqual(
			borrowedOriginCursor({ closedFloor: 12000, originGeneration: 'g0' }, { floor: 9000, generation: 'g1' }),
			cursorBelowFloor(9000)
		);
	});

	it('lowers a position by the overlap, and never a floor', () => {
		assert.strictEqual(borrowedOriginCursor({ originLogKey: 100_000 }, undefined, 60_000), 40_000);
		assert.strictEqual(borrowedOriginCursor({ originLogKey: 5000 }, undefined, 60_000), 2);
		assert.strictEqual(
			borrowedOriginCursor({ originLogKey: 100_000, closedFloor: 90_000 }, undefined, 60_000),
			cursorBelowFloor(90_000)
		);
		assert.strictEqual(
			borrowedOriginCursor({ originLogKey: 100_000 }, { floor: 70_000, generation: 'g1' }, 60_000),
			cursorBelowFloor(70_000)
		);
	});

	it('has no cursor with neither source', () => {
		assert.strictEqual(borrowedOriginCursor(undefined, undefined), undefined);
	});
});
