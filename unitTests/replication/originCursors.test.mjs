/**
 * The per-origin cursor vector (harper-pro#989, W4 harper-pro#434): what a subscriber sends, how a sender turns it
 * into per-origin starts, and the subscription predicate that bounds an unlisted origin by its start.
 */
import assert from 'node:assert';
import {
	ORIGIN_CURSOR_OVERLAP_MS,
	buildOriginCursorVector,
	collectRelayedLogAnchors,
	collectSeqRows,
	matchesSubscriptionPosition,
	parseOriginKeyMap,
	resolveOriginFloors,
	retainedResumeRange,
} from '#src/replication/replicationConnection';

const SEQ = Symbol.for('seq');
const T = 1_790_000_000_000;
const names = new Map([
	[0, 'self'],
	[1, 'peer'],
	[2, 'relayed'],
	[3, 'removed'],
	[4, 'member'],
]);
const nameForId = (id) => names.get(id);

describe('buildOriginCursorVector', () => {
	const isMember = (name) => name !== 'removed';

	it("sends the peer row's origin cursors, and never another peer's", () => {
		const rows = new Map([
			[
				1,
				{
					seqId: T,
					nodes: [
						{ id: 1, originLogKey: T - 1 },
						{ id: 2, originLogKey: T - 2 },
					],
				},
			],
			[4, { seqId: T, nodes: [{ id: 2, originLogKey: T + 1000 }] }],
		]);
		assert.deepStrictEqual(buildOriginCursorVector(rows, 1, nameForId, isMember), { peer: T - 1, relayed: T - 2 });
	});

	it("seeds a removed origin from its own connection's row: its own-origin cursor, else seqId", () => {
		const withOwnCursor = new Map([
			[1, { seqId: T, nodes: [] }],
			[3, { seqId: T + 5000, nodes: [{ id: 3, originLogKey: T - 300 }] }],
		]);
		assert.deepStrictEqual(buildOriginCursorVector(withOwnCursor, 1, nameForId, isMember), { removed: T - 300 });
		// a row written before origin cursors existed
		const legacy = new Map([
			[1, { seqId: T, nodes: [] }],
			[3, { seqId: T - 400 }],
		]);
		assert.deepStrictEqual(buildOriginCursorVector(legacy, 1, nameForId, isMember), { removed: T - 400 });
	});

	it('does not seed a current member from its direct row, and prefers the peer row over seeding', () => {
		const rows = new Map([
			[1, { seqId: T, nodes: [{ id: 3, originLogKey: T - 10 }] }],
			[3, { seqId: T + 9000 }],
			[4, { seqId: T + 9000 }],
		]);
		assert.deepStrictEqual(buildOriginCursorVector(rows, 1, nameForId, isMember), { removed: T - 10 });
	});

	it('skips this node, unnamed ids, and malformed rows or entries', () => {
		const rows = new Map([
			[
				1,
				{
					seqId: T,
					nodes: [null, 'x', { id: 0, originLogKey: T }, { id: 9, originLogKey: T }, { id: 2, originLogKey: 'T' }],
				},
			],
			[0, { seqId: T }],
			[3, { seqId: 1, nodes: 'not-an-array' }],
		]);
		assert.deepStrictEqual(buildOriginCursorVector(rows, 1, nameForId, isMember), {});
	});
});

describe('collectSeqRows', () => {
	it('keys rows by id and skips a row that does not decode', () => {
		const rows = collectSeqRows([
			{ key: [SEQ, 1], value: { seqId: T } },
			{
				key: [SEQ, 2],
				get value() {
					throw new Error('Data read, but end of buffer not reached');
				},
			},
			{ key: [SEQ, 3], value: null },
		]);
		assert.deepStrictEqual([...rows.keys()], [1]);
	});
});

describe('resolveOriginFloors', () => {
	const nameToId = { relayed: 2, removed: 3 };

	it('starts each origin the overlap window below its cursor', () => {
		assert.deepStrictEqual(
			resolveOriginFloors({ relayed: T, removed: T - 5 }, nameToId),
			new Map([
				['relayed', T - ORIGIN_CURSOR_OVERLAP_MS],
				['removed', T - 5 - ORIGIN_CURSOR_OVERLAP_MS],
			])
		);
	});

	it('ignores unknown origins, inherited names, malformed values and malformed maps', () => {
		assert.deepStrictEqual(
			resolveOriginFloors({ unknown: T, constructor: T, toString: T, relayed: 'soon', removed: -1 }, nameToId),
			new Map()
		);
		for (const vector of [undefined, null, 'x', [T], 42]) {
			assert.deepStrictEqual(resolveOriginFloors(vector, nameToId), new Map(), String(vector));
		}
	});

	it('gives no start when the overlap reaches below the first key', () => {
		assert.deepStrictEqual(resolveOriginFloors({ relayed: ORIGIN_CURSOR_OVERLAP_MS }, nameToId), new Map());
	});
});

describe('parseOriginKeyMap', () => {
	it('keeps only own entries with a valid log key', () => {
		const parsed = parseOriginKeyMap(JSON.parse(`{"__proto__": ${T}, "a": ${T}, "b": null}`));
		assert.deepStrictEqual([...parsed.keys()].sort(), ['__proto__', 'a']);
	});
});

describe('matchesSubscriptionPosition', () => {
	it('bounds an unlisted origin by its start only when it has one', () => {
		assert.strictEqual(matchesSubscriptionPosition(undefined, true, undefined, 5), true);
		assert.strictEqual(matchesSubscriptionPosition(undefined, true, T, T), false);
		assert.strictEqual(matchesSubscriptionPosition(undefined, true, T, T + 1), true);
	});

	it('keeps the listed, excluded and single-log behavior', () => {
		assert.strictEqual(matchesSubscriptionPosition(undefined, false, undefined, T), false);
		assert.strictEqual(matchesSubscriptionPosition(false, true, undefined, T), false);
		assert.strictEqual(matchesSubscriptionPosition({ startTime: T }, true, undefined, T), false);
		assert.strictEqual(matchesSubscriptionPosition({ startTime: T }, true, undefined, T + 1), true);
		assert.strictEqual(matchesSubscriptionPosition({ startTime: T, endTime: T + 2 }, true, undefined, T + 2), false);
	});
});

// Logs as arrays of keys in append order; a range yields keys at or above `start`, or from the exact key on.
function fakeAuditStore(logs) {
	return {
		logByName: new Map(Object.keys(logs).map((name) => [name, {}])),
		loadLogs() {},
		getRange({ start = 0, exactStart, log }) {
			const keys = logs[log] ?? [];
			const from = exactStart ? keys.indexOf(start) : 0;
			if (from < 0) return [];
			return keys
				.slice(from)
				.filter((key) => exactStart || key >= start)
				.map((txnLogKey) => ({ txnLogKey }));
		},
	};
}

describe('collectRelayedLogAnchors', () => {
	it("anchors each relayed log at its last committed key, skipping the sender's own, the skipped and empty logs", () => {
		const store = fakeAuditStore({ local: [T], removed: [T - 30, T - 20, T - 10], excluded: [T], empty: [] });
		assert.deepStrictEqual(collectRelayedLogAnchors(store, new Set(['excluded'])), new Map([['removed', T - 10]]));
	});
});

describe('retainedResumeRange', () => {
	it('resumes the local log and every other log in scope past their exact entries', () => {
		const range = retainedResumeRange(T, ['removed'], { removed: T - 50, unrelated: T }, ['self']);
		assert.deepStrictEqual(
			range.startByLog,
			new Map([
				['local', T],
				['removed', T - 50],
			])
		);
		assert.strictEqual(range.resumeAfterExactStart, true);
		assert.strictEqual(range.exactStart, true);
		assert.deepStrictEqual(range.excludeLogs, ['self']);
		assert.strictEqual(range.log, undefined);
	});

	it('reads only the local log for a single-log subscription', () => {
		assert.strictEqual(retainedResumeRange(T, [], undefined, undefined).log, 'local');
	});

	it('gives no range when another log in scope has no usable cursor', () => {
		assert.strictEqual(retainedResumeRange(T, ['removed'], {}, []), undefined);
		assert.strictEqual(retainedResumeRange(T, ['removed'], undefined, []), undefined);
		assert.strictEqual(retainedResumeRange(T, ['removed'], { removed: 'T' }, []), undefined);
		assert.strictEqual(retainedResumeRange(T, ['toString'], {}, []), undefined);
	});
});
