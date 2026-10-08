/**
 * Origin-closed floor certificates (harper-pro#922 item 2): the resume value a stored floor contributes, the floors a
 * relay may forward, the received-vector parse, and the receiver's blob-gated pending set.
 */
import assert from 'node:assert';
import {
	ORIGIN_CURSOR_OVERLAP_MS,
	PendingOriginFloors,
	buildOriginCursorVector,
	collectRelayableFloors,
	cursorBelowFloor,
	parseOriginFloors,
	resolveOriginFloors,
	resumeStartWithFloor,
} from '#src/replication/replicationConnection';

const T = 1_790_000_000_000;
const names = new Map([
	[0, 'self'],
	[1, 'peer'],
	[2, 'relayed'],
	[3, 'other'],
]);
const nameForId = (id) => names.get(id);
const nameToId = { peer: 1, relayed: 2, other: 3 };
const isMember = () => true;

describe('cursorBelowFloor', () => {
	it('is the greatest float64 below the floor, so an exclusive start at it still delivers the floor key', () => {
		const below = cursorBelowFloor(T);
		assert.ok(below < T);
		assert.ok((below + T) / 2 === below || (below + T) / 2 === T, 'no float64 lies between');
		assert.ok(T - below < 0.001);
	});
});

describe('resumeStartWithFloor', () => {
	it('takes the floor only where it is newer than the applied position', () => {
		assert.strictEqual(resumeStartWithFloor(T, T + 1000), cursorBelowFloor(T + 1000));
		assert.strictEqual(resumeStartWithFloor(T, T - 1000), T);
	});

	it('ignores a missing or malformed floor', () => {
		for (const floor of [undefined, null, 0, -1, NaN, Infinity, 8.64e15, '1']) {
			assert.strictEqual(resumeStartWithFloor(T, floor), T, String(floor));
		}
	});
});

describe('parseOriginFloors', () => {
	it('keeps valid entries and drops malformed ones or a malformed vector', () => {
		assert.deepStrictEqual([...parseOriginFloors({ peer: T, relayed: 'x', other: Infinity, bad: -1 })], [['peer', T]]);
		for (const vector of [undefined, null, 'x', 3, [T]]) assert.strictEqual(parseOriginFloors(vector).size, 0);
	});
});

describe('collectRelayableFloors', () => {
	const row = (id, state) => [id, { seqId: T, nodes: [state] }];

	it("forwards only a floor from the origin's own direct row that it marked relayable", () => {
		const rows = new Map([
			row(1, { id: 1, originLogKey: T, closedFloor: T - 5, relayable: true }),
			row(2, { id: 2, originLogKey: T, closedFloor: T - 6, relayable: false }),
			// a floor for `other` learned over the `peer` link lives on peer's row, never on other's own row
			[3, { seqId: T, nodes: [{ id: 1, closedFloor: T - 1, relayable: true }] }],
		]);
		assert.deepStrictEqual(
			[...collectRelayableFloors(rows, ['peer', 'relayed', 'other', 'unknown'], nameToId)],
			[['peer', T - 5]]
		);
	});

	it('never mints an id and ignores a malformed floor', () => {
		const rows = new Map([row(1, { id: 1, closedFloor: NaN, relayable: true })]);
		assert.strictEqual(collectRelayableFloors(rows, ['peer', 'ghost'], nameToId).size, 0);
		assert.strictEqual(collectRelayableFloors(rows, ['peer'], undefined).size, 0);
		assert.strictEqual(collectRelayableFloors(rows, ['peer'], { peer: 'x' }).size, 0);
	});
});

describe('buildOriginCursorVector with floors', () => {
	const rows = new Map([
		[
			1,
			{
				seqId: T,
				nodes: [
					{ id: 1, originLogKey: T - 100, closedFloor: T - 10 },
					{ id: 2, originLogKey: T - 20, closedFloor: T - 200 },
					{ id: 3, closedFloor: T - 30 },
				],
			},
		],
	]);

	it('folds a stored floor into the value only while the peer certifies', () => {
		assert.deepStrictEqual(buildOriginCursorVector(rows, 1, nameForId, isMember, true), {
			peer: cursorBelowFloor(T - 10),
			relayed: T - 20,
			other: cursorBelowFloor(T - 30),
		});
		assert.deepStrictEqual(buildOriginCursorVector(rows, 1, nameForId, isMember, false), {
			peer: T - 100,
			relayed: T - 20,
		});
		assert.deepStrictEqual(buildOriginCursorVector(rows, 1, nameForId, isMember), {
			peer: T - 100,
			relayed: T - 20,
		});
	});

	it('is still resolved by the sender with the overlap, so a floor-only cursor starts below the floor', () => {
		const vector = buildOriginCursorVector(rows, 1, nameForId, isMember, true);
		const floors = resolveOriginFloors(vector, nameToId);
		assert.ok(floors.get('other') < T - 30 && floors.get('other') > T - 31 - ORIGIN_CURSOR_OVERLAP_MS);
	});
});

describe('PendingOriginFloors', () => {
	it('merges by max, keeps a relayable flag that turns on, and releases only when unblocked', () => {
		const pending = new PendingOriginFloors();
		pending.note([
			[7, T - 10, false],
			[8, T, true],
		]);
		pending.note([
			[7, T - 10, true],
			[8, T - 5, false],
		]);
		assert.strictEqual(pending.take(true), undefined, 'held under the blob rule');
		assert.strictEqual(pending.size, 2);
		assert.deepStrictEqual(pending.take(false), [
			[7, T - 10, true],
			[8, T, true],
		]);
		assert.strictEqual(pending.take(false), undefined, 'nothing is released twice');
		assert.strictEqual(pending.size, 0);
	});

	it('an event that carried nothing releases only floors an earlier event admitted', () => {
		const pending = new PendingOriginFloors();
		assert.strictEqual(pending.take(false), undefined);
		pending.note(undefined);
		assert.strictEqual(pending.size, 0);
	});
});
