/** `DB_SCHEMA[4]` can make this node drop a table, so what a peer sends is validated and bounded first. */

import assert from 'node:assert/strict';
import { validateDropMarkers, rowsAround, MAX_DROP_MARKERS_PER_FRAME } from '#src/replication/tableLifecycle';

describe('validateDropMarkers', () => {
	it('keeps only well-formed entries and the newest drop per table', () => {
		const markers = validateDropMarkers([
			{ table: 'a', droppedTime: 10 },
			{ table: 'a', droppedTime: 20 },
			{ table: 'a', droppedTime: 15 },
			{ table: 'b', droppedTime: 'soon' },
			{ table: 'c', droppedTime: Number.POSITIVE_INFINITY },
			{ table: 'd', droppedTime: 0 },
			{ table: '', droppedTime: 5 },
			{ table: 'e/f', droppedTime: 5 },
			{ table: 7, droppedTime: 5 },
			null,
			'x',
			{ table: 'g', droppedTime: 1, extra: 'ignored' },
		]);
		assert.deepEqual(markers, [
			{ table: 'a', droppedTime: 20 },
			{ table: 'g', droppedTime: 1 },
		]);
	});

	it('returns nothing for a missing or malformed list', () => {
		assert.deepEqual(validateDropMarkers(undefined), []);
		assert.deepEqual(validateDropMarkers({ table: 'a', droppedTime: 1 }), []);
	});

	it('bounds the list a peer can send', () => {
		const raw = Array.from({ length: MAX_DROP_MARKERS_PER_FRAME + 5 }, (_, i) => ({ table: 't' + i, droppedTime: 1 }));
		assert.equal(validateDropMarkers(raw).length, MAX_DROP_MARKERS_PER_FRAME);
	});
});

describe('rowsAround', () => {
	const tableWith = (...versions) => ({
		primaryStore: {
			getRange() {
				return versions.map((version) => ({ version }));
			},
		},
	});
	it('reports a row written before the drop, and whether any row was written after it', async () => {
		assert.deepEqual(await rowsAround(tableWith(150, 99, 200), 100), { older: true, newer: true });
		assert.deepEqual(await rowsAround(tableWith(99), 100), { older: true, newer: false });
		assert.deepEqual(await rowsAround(tableWith(100, 150), 100), { older: false, newer: true });
		assert.deepEqual(await rowsAround(tableWith(), 100), { older: false, newer: false });
	});
	it('yields the worker while it reads a large table in full', async () => {
		let turns = 0;
		const ticker = setInterval(() => turns++, 0);
		try {
			const versions = Array.from({ length: 50000 }, () => 200);
			assert.deepEqual(await rowsAround(tableWith(...versions), 100), { older: false, newer: true });
		} finally {
			clearInterval(ticker);
		}
		assert.ok(turns > 0, 'other work ran during the scan');
	});
});
