/**
 * `DB_SCHEMA[4]` can make this node drop a table, so what a peer sends is validated and bounded before
 * it is compared; these pin that validation and the dead-generation rule the two schema ingress paths share.
 */

import assert from 'node:assert/strict';
import {
	validateDropMarkers,
	dropMarkersByTable,
	definitionIsDead,
	MAX_DROP_MARKERS_PER_FRAME,
} from '#src/replication/tableLifecycle';

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

describe('dropMarkersByTable', () => {
	it('indexes by table keeping the newest drop', () => {
		const byTable = dropMarkersByTable([
			{ table: 'a', droppedTime: 3 },
			{ table: 'a', droppedTime: 9 },
			{ table: 'b', droppedTime: 1 },
		]);
		assert.equal(byTable.get('a').droppedTime, 9);
		assert.equal(byTable.get('b').droppedTime, 1);
	});
});

describe('definitionIsDead', () => {
	const marker = { table: 'x', droppedTime: 100 };
	it('is alive without a marker, whatever the stamp', () => {
		assert.equal(definitionIsDead({ createdTime: 1 }, undefined), false);
		assert.equal(definitionIsDead({}, undefined), false);
	});
	it('is dead when created before the drop, alive at or after it', () => {
		assert.equal(definitionIsDead({ createdTime: 99 }, marker), true);
		assert.equal(definitionIsDead({ createdTime: 100 }, marker), false);
		assert.equal(definitionIsDead({ createdTime: 101 }, marker), false);
	});
	it('treats a missing or malformed stamp as older than any drop', () => {
		assert.equal(definitionIsDead({}, marker), true);
		assert.equal(definitionIsDead({ createdTime: '101' }, marker), true);
		assert.equal(definitionIsDead({ createdTime: Number.NaN }, marker), true);
	});
	it('lets an unstamped peer describe a local generation that is newer than the marker', () => {
		assert.equal(definitionIsDead({}, marker, { createdTime: 100 }), false);
		assert.equal(definitionIsDead({}, marker, { createdTime: 150 }), false);
		assert.equal(definitionIsDead({}, marker, { createdTime: 99 }), true, 'a stale local copy does not absorb it');
		assert.equal(definitionIsDead({}, marker, {}), true, 'an unstamped local copy is itself dead');
		assert.equal(
			definitionIsDead({ createdTime: 50 }, marker, { createdTime: 150 }),
			true,
			'a stamped stale copy stays dead'
		);
	});
});
