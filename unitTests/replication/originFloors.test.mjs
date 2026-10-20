import assert from 'node:assert';
import {
	ORIGIN_CURSOR_OVERLAP_MS,
	PendingOriginFloors,
	PendingRouteState,
	buildOriginCursorVector,
	collectRelayableCertificates,
	cursorBelowFloor,
	encodeOriginCertificate,
	parseOriginCertificates,
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

describe('parseOriginCertificates', () => {
	it('keeps valid entries and drops malformed ones or a malformed vector', () => {
		assert.deepStrictEqual(
			[...parseOriginCertificates({ peer: T, relayed: 'x', other: Infinity, bad: -1 })],
			[['peer', { floor: T }]]
		);
		for (const vector of [undefined, null, 'x', 3, [T]]) assert.strictEqual(parseOriginCertificates(vector).size, 0);
	});
});

describe('collectRelayableCertificates', () => {
	const row = (id, state) => [id, { seqId: T, nodes: [state] }];

	const certifies = () => 1;
	const floors = (map) => [...map].map(([name, certificate]) => [name, certificate.floor]);

	it("forwards only a floor from the origin's own direct row that it marked relayable, while it certifies", () => {
		const rows = new Map([
			row(1, { id: 1, originLogKey: T, closedFloor: T - 5, relayable: true }),
			row(2, { id: 2, originLogKey: T, closedFloor: T - 6, relayable: false }),
			// a floor for `other` learned over the `peer` link lives on peer's row, never on other's own row
			[3, { seqId: T, nodes: [{ id: 1, closedFloor: T - 1, relayable: true }] }],
		]);
		const names = ['peer', 'relayed', 'other', 'unknown'];
		assert.deepStrictEqual(floors(collectRelayableCertificates(rows, names, nameToId, certifies)), [['peer', T - 5]]);
		// an origin whose current socket no longer certifies may be an older binary writing below its floor
		assert.strictEqual(collectRelayableCertificates(rows, names, nameToId, (name) => name !== 'peer').size, 0);
	});

	it('never mints an id and ignores a malformed floor', () => {
		const rows = new Map([row(1, { id: 1, closedFloor: NaN, relayable: true })]);
		assert.strictEqual(collectRelayableCertificates(rows, ['peer', 'ghost'], nameToId, certifies).size, 0);
		assert.strictEqual(collectRelayableCertificates(rows, ['peer'], undefined, certifies).size, 0);
		assert.strictEqual(collectRelayableCertificates(rows, ['peer'], { peer: 'x' }, certifies).size, 0);
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

describe('level-2 certificates (harper-pro#922 items 3–4)', () => {
	const row = (id, state) => [id, { seqId: T, nodes: [state] }];

	it('parses a floor, a checkpoint-grade tuple and a revocation, dropping malformed entries', () => {
		const parsed = parseOriginCertificates({
			peer: T,
			relayed: [T - 5, 'gen-r', true],
			other: 0,
			partial: [T - 6, 'gen-p'],
			bad: [T, ''],
			worse: ['x', 'gen'],
		});
		assert.deepStrictEqual(
			[...parsed],
			[
				['peer', { floor: T }],
				['relayed', { floor: T - 5, generation: 'gen-r', fullCoverage: true }],
				['other', { revoked: true }],
				['partial', { floor: T - 6, generation: 'gen-p', fullCoverage: false }],
			]
		);
	});

	it('encodes for the peer level: a level-1 peer gets floors only and no revocation', () => {
		const certificate = { floor: T, generation: 'g', fullCoverage: true };
		assert.deepStrictEqual(encodeOriginCertificate(certificate, 2), [T, 'g', true]);
		assert.strictEqual(encodeOriginCertificate(certificate, 1), T);
		assert.strictEqual(encodeOriginCertificate({ floor: T }, 2), T);
		assert.strictEqual(encodeOriginCertificate({ revoked: true }, 2), 0);
		assert.strictEqual(encodeOriginCertificate({ revoked: true }, 1), undefined);
	});

	it('relays checkpoint-grade qualifiers only from a row whose socket certifies at level 2, and a revocation always', () => {
		const rows = new Map([
			row(1, { id: 1, closedFloor: T - 5, relayable: true, originGeneration: 'gen-p', fullCoverage: true }),
			row(2, { id: 2, closedFloor: T - 6, relayable: true, originGeneration: 'gen-r', fullCoverage: false }),
			row(3, { id: 3, closedFloor: T - 7, relayable: true, floorRevoked: true }),
		]);
		const names = ['peer', 'relayed', 'other'];
		assert.deepStrictEqual(
			[...collectRelayableCertificates(rows, names, nameToId, () => 2)],
			[
				['peer', { floor: T - 5, generation: 'gen-p', fullCoverage: true }],
				['relayed', { floor: T - 6 }],
				['other', { revoked: true }],
			]
		);
		assert.deepStrictEqual(
			[...collectRelayableCertificates(rows, names, nameToId, () => 1)],
			[
				['peer', { floor: T - 5 }],
				['relayed', { floor: T - 6 }],
				['other', { revoked: true }],
			]
		);
		assert.deepStrictEqual(
			[...collectRelayableCertificates(rows, names, nameToId, () => 0)],
			[['other', { revoked: true }]]
		);
	});

	it('resumes a whole-route checkpoint-grade row exactly below its floor, ignoring a higher position, and reports it', () => {
		const rows = new Map([
			[
				1,
				{
					seqId: T,
					nodes: [
						{ id: 1, originLogKey: T, closedFloor: T - 10, originGeneration: 'g', fullCoverage: true },
						{ id: 2, originLogKey: T, closedFloor: T - 20, originGeneration: 'g' },
						{
							id: 3,
							originLogKey: T,
							closedFloor: T - 30,
							originGeneration: 'g',
							fullCoverage: true,
							floorRevoked: true,
						},
					],
				},
			],
		]);
		const reported = [];
		const vector = buildOriginCursorVector(rows, 1, nameForId, isMember, true, (id, start, generation) =>
			reported.push([id, start, generation])
		);
		assert.deepStrictEqual(vector, { peer: cursorBelowFloor(T - 10), relayed: T, other: T });
		assert.deepStrictEqual(reported, [[1, cursorBelowFloor(T - 10), 'g']]);
		// without the level-2 route the position still wins where it is newer
		assert.deepStrictEqual(buildOriginCursorVector(rows, 1, nameForId, isMember, true), {
			peer: T,
			relayed: T,
			other: T,
		});
	});

	it('PendingOriginFloors keeps the level-2 fields a same-floor certificate carries', () => {
		const pending = new PendingOriginFloors();
		pending.note([[7, T, false]]);
		pending.note([[7, T, true, 'gen', true]]);
		assert.deepStrictEqual(pending.take(false), [[7, T, true, 'gen', true]]);
	});

	it('PendingRouteState attaches generation-scoped marks and revocations, settled when their update commits', async () => {
		const pending = new PendingRouteState();
		pending.certifiedFrom(1, T, 'g1');
		pending.certifiedFrom(1, T - 5, 'g1');
		pending.certifiedFrom(1, T + 5, 'g1');
		pending.hole(2);
		pending.partialHistory(3, true, 'g3');
		pending.revoke(4, 'g4');
		assert.strictEqual(pending.size, 4);
		const event = { onCommit: async () => (event.committed = true) };
		pending.attachTo(event);
		assert.deepStrictEqual(event.originRouteStates, [
			[1, T - 5, undefined, undefined, 'g1'],
			[2, undefined, undefined, true, undefined],
			[3, undefined, true, undefined, 'g3'],
		]);
		assert.deepStrictEqual(event.originFloorRevocations, [[4, 'g4']]);
		// a held or failed update keeps them for the next one
		assert.strictEqual(pending.size, 4);
		// a mark changed after it was attached survives the commit
		pending.partialHistory(3, false, 'g3');
		await event.onCommit();
		assert.strictEqual(event.committed, true);
		assert.strictEqual(pending.size, 1);
		const rest = {};
		pending.takeInto(rest);
		assert.deepStrictEqual(rest, { originRouteStates: [[3, undefined, false, undefined, 'g3']] });
		assert.strictEqual(pending.size, 0);
		const empty = {};
		pending.attachTo(empty);
		assert.deepStrictEqual(empty, {});
	});

	it('relays no checkpoint-grade fields from a row with a hole or partial history', () => {
		const rows = new Map([
			row(1, { id: 1, closedFloor: T - 5, relayable: true, originGeneration: 'g', fullCoverage: true, hole: true }),
			row(2, {
				id: 2,
				closedFloor: T - 6,
				relayable: true,
				originGeneration: 'g',
				fullCoverage: true,
				partialHistory: true,
			}),
		]);
		assert.deepStrictEqual(
			[...collectRelayableCertificates(rows, ['peer', 'relayed'], nameToId, () => 2)],
			[
				['peer', { floor: T - 5 }],
				['relayed', { floor: T - 6 }],
			]
		);
	});

	it('PendingOriginFloors lets a new generation replace a held certificate whatever its floor', () => {
		const pending = new PendingOriginFloors();
		pending.note([[7, T, true, 'gen-1', true]]);
		pending.note([[7, T - 10, true, 'gen-2', true]]);
		assert.deepStrictEqual(pending.take(false), [[7, T - 10, true, 'gen-2', true]]);
	});
});
