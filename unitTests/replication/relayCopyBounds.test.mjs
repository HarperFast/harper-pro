/**
 * A relaying sender against rows a base copy wrote on it without log entries (harper-pro#1291): its replay of a
 * relayed log skips them, so a follower below them gets a copy, and a live session reconnects when they appear.
 */
import assert from 'node:assert';
import {
	readRelayCopyBounds,
	relayedHeldFrom,
	relayedStartBelowCopyBound,
	relayedCursorsForCopy,
	copyBoundRoseForLogs,
	withheldRecordAction,
	ORIGIN_CURSOR_OVERLAP_MS,
} from '#src/replication/replicationConnection';

const T = 1_790_000_000_000;
const COPY_BOUND = Symbol.for('copyBound');
const ids = { relayed: 2, other: 3 };
const rowsStore = (rows) => ({ getRange: () => rows.map(([key, value]) => ({ key, value })) });
const bounds = (settled = {}, reserved = {}) => ({
	settled: new Map(Object.entries(settled)),
	reserved: new Map(Object.entries(reserved)),
});

describe('readRelayCopyBounds', () => {
	it('splits settled rows from reservations by origin name and leaves holes out', () => {
		const read = readRelayCopyBounds(
			rowsStore([
				[[COPY_BOUND, 6], { 2: T, 3: T + 5 }],
				[[COPY_BOUND, 7], { 2: T + 10 }],
				[[COPY_BOUND, 6, 'reserved', 0], { 3: T + 20 }],
				[[COPY_BOUND, 6, 'hole', 0, 1, T], { 2: Number.MAX_VALUE }],
			]),
			ids
		);
		assert.deepStrictEqual(
			read.settled,
			new Map([
				['relayed', T + 10],
				['other', T + 5],
			])
		);
		assert.deepStrictEqual(read.reserved, new Map([['other', T + 20]]));
	});

	it('throws on a malformed row rather than reading it as no bound', () => {
		assert.throws(() => readRelayCopyBounds(rowsStore([[[COPY_BOUND, 6], { 2: 'x' }]]), ids));
	});
});

describe('relayedHeldFrom', () => {
	it('starts at the floor plus the overlap, at 0 for an origin held only by copy, else at the merged start', () => {
		assert.strictEqual(relayedHeldFrom(T, true, T + 5), T + ORIGIN_CURSOR_OVERLAP_MS);
		assert.strictEqual(relayedHeldFrom(undefined, true, T + 5), 0);
		assert.strictEqual(relayedHeldFrom(undefined, false, T + 5), T + 5);
	});
});

describe('withheldRecordAction', () => {
	const held = new Set(['relayed']);
	it("sends this node's own records, including an origin id with no name", () => {
		assert.strictEqual(withheldRecordAction('self', 'self', held), 'send');
		assert.strictEqual(withheldRecordAction(undefined, 'self', held), 'send');
	});
	it('skips an origin whose start the follower holds and parks on any other', () => {
		assert.strictEqual(withheldRecordAction('relayed', 'self', held), 'skip');
		assert.strictEqual(withheldRecordAction('other', 'self', held), 'park');
	});
});

describe('relayedStartBelowCopyBound', () => {
	const settled = (entries) => new Map(Object.entries(entries));

	it('finds a relayed log whose follower cursor is below the settled bound', () => {
		const floors = new Map([['relayed', T - ORIGIN_CURSOR_OVERLAP_MS]]);
		assert.deepStrictEqual(
			relayedStartBelowCopyBound(['local', 'relayed'], T + 100, floors, settled({ relayed: T + 1 })),
			{ log: 'relayed', start: T, bound: T + 1 }
		);
	});

	it('passes a follower at or past the bound, and the local log, which a copy never leaves short', () => {
		const floors = new Map([['relayed', T + 1 - ORIGIN_CURSOR_OVERLAP_MS]]);
		assert.strictEqual(
			relayedStartBelowCopyBound(['local', 'relayed'], 0, floors, settled({ relayed: T + 1, local: T + 9 })),
			undefined
		);
	});

	it('compares a log with no cursor from the merged start', () => {
		assert.strictEqual(relayedStartBelowCopyBound(['other'], T, undefined, settled({ other: T + 1 }))?.start, T);
		assert.strictEqual(relayedStartBelowCopyBound(['other'], T + 1, undefined, settled({ other: T + 1 })), undefined);
	});
});

describe('relayedCursorsForCopy', () => {
	it('raises each relayed cursor to the settled bound, adding logs with no anchor', () => {
		const cursors = relayedCursorsForCopy(
			new Map([
				['relayed', T],
				['other', T + 50],
			]),
			new Map([
				['relayed', T + 20],
				['other', T + 10],
				['unanchored', T + 30],
				['excluded', T + 40],
				['local', T + 60],
			]),
			(log) => log !== 'excluded'
		);
		assert.deepStrictEqual(
			cursors,
			new Map([
				['relayed', T + 20],
				['other', T + 50],
				['unanchored', T + 30],
			])
		);
	});
});

describe('copyBoundRoseForLogs', () => {
	it('names a replayed log whose reservation or settled bound rose', () => {
		const before = bounds({ relayed: T });
		assert.strictEqual(copyBoundRoseForLogs(before, bounds({ relayed: T + 1 }), ['relayed']), 'relayed');
		assert.strictEqual(
			copyBoundRoseForLogs(before, bounds({ relayed: T }, { other: T }), ['relayed', 'other']),
			'other'
		);
	});

	it('names a settle that replaces the reservation the session started under', () => {
		assert.strictEqual(
			copyBoundRoseForLogs(bounds({}, { relayed: T + 9 }), bounds({ relayed: T + 3 }), ['relayed']),
			'relayed'
		);
	});

	it('ignores logs the session does not replay, an unchanged bound and a released reservation', () => {
		assert.strictEqual(copyBoundRoseForLogs(bounds(), bounds({ other: T }), ['relayed']), undefined);
		assert.strictEqual(copyBoundRoseForLogs(bounds({ relayed: T }), bounds({ relayed: T }), ['relayed']), undefined);
		assert.strictEqual(
			copyBoundRoseForLogs(bounds({ relayed: T }, { relayed: T + 9 }), bounds({ relayed: T }), ['relayed']),
			undefined
		);
		assert.strictEqual(copyBoundRoseForLogs(bounds(), bounds({ local: T }), ['local']), undefined);
	});
});
