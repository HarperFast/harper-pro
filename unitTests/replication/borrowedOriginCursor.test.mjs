import assert from 'node:assert';
import {
	borrowedOriginCursor,
	borrowFromRelievedRoutes,
	cursorBelowFloor,
} from '#src/replication/replicationConnection';

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

describe('borrowFromRelievedRoutes', () => {
	it('passes over a route that recorded nothing for the origin (the quiet-join trace)', () => {
		// .81's row after only copying; .82's row from carrying the origin
		const joiner = { id: 3, partialHistory: false };
		const carrier = { id: 3, closedFloor: 7000, originLogKey: 9000 };
		const { cursor, state } = borrowFromRelievedRoutes([joiner, undefined, carrier], undefined);
		assert.strictEqual(cursor, 9000);
		assert.strictEqual(state, carrier);
	});

	it('takes the highest position among the routes, not the most recent one', () => {
		// a supplier reused after another carried the origin further keeps its older, lower position
		const reused = { originLogKey: 200 };
		const further = { originLogKey: 1000 };
		assert.strictEqual(borrowFromRelievedRoutes([reused, further], undefined).cursor, 1000);
		assert.strictEqual(borrowFromRelievedRoutes([reused, further], undefined, 100).cursor, 900);
	});

	it('passes over flagged routes, and takes a floor-only route', () => {
		const flagged = { originLogKey: 12000, hole: true };
		const floorOnly = { closedFloor: 5000 };
		assert.strictEqual(borrowFromRelievedRoutes([flagged, floorOnly], undefined).cursor, cursorBelowFloor(5000));
	});

	it("counts only the most recent positioned route's generation", () => {
		const current = { originLogKey: 300, originGeneration: 'g1' };
		const replaced = { originLogKey: 5000, originGeneration: 'g0' };
		const { cursor, state } = borrowFromRelievedRoutes([current, replaced], undefined);
		assert.strictEqual(cursor, 300);
		assert.strictEqual(state, current);
	});

	it('combines the chosen route with the qualified floor as borrowedOriginCursor does', () => {
		const qualified = { floor: 9000, generation: 'g1' };
		assert.strictEqual(
			borrowFromRelievedRoutes([{ originLogKey: 5000, originGeneration: 'g1' }], qualified).cursor,
			cursorBelowFloor(9000)
		);
		assert.strictEqual(
			borrowFromRelievedRoutes([{ originLogKey: 12000, originGeneration: 'g1' }], qualified).cursor,
			12000
		);
	});

	it('falls back to the qualified floor alone, or to nothing', () => {
		const qualified = { floor: 9000, generation: 'g1' };
		assert.deepEqual(borrowFromRelievedRoutes([{ id: 3 }, undefined], qualified), { cursor: cursorBelowFloor(9000) });
		assert.deepEqual(borrowFromRelievedRoutes([], undefined), { cursor: undefined });
	});
});
