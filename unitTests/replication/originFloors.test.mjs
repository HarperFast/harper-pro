import assert from 'node:assert';
import {
	ORIGIN_CURSOR_OVERLAP_MS,
	PendingOriginFloors,
	PendingRouteState,
	buildOriginCursorVector,
	checkpointGradeRow,
	clearGenlessClosedFloorOnSeqRow,
	collectRelayableCertificates,
	cursorBelowFloor,
	encodeOriginCertificate,
	mergePersistedCopyBounds,
	parseOriginCertificates,
	persistMergedCopyBounds,
	resolveOriginFloors,
	restoreCompletedCopyPass,
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

	it('relays checkpoint-grade qualifiers only from a row whose socket certifies at level 2 and has certifiedFrom <= below(floor), and a revocation always', () => {
		const rows = new Map([
			row(1, {
				id: 1,
				closedFloor: T - 5,
				relayable: true,
				originGeneration: 'gen-p',
				fullCoverage: true,
				certifiedFrom: 0,
			}),
			row(2, {
				id: 2,
				closedFloor: T - 6,
				relayable: true,
				originGeneration: 'gen-r',
				fullCoverage: false,
				certifiedFrom: 0,
			}),
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
		// A route without certifiedFrom (or with certifiedFrom > cursorBelowFloor(closedFloor)) relays only its scalar floor.
		const uncertifiedRows = new Map([
			row(1, {
				id: 1,
				closedFloor: T - 5,
				relayable: true,
				originGeneration: 'gen-p',
				fullCoverage: true,
			}),
			row(2, {
				id: 2,
				closedFloor: T - 6,
				relayable: true,
				originGeneration: 'gen-r',
				fullCoverage: true,
				certifiedFrom: T - 6,
			}),
		]);
		assert.deepStrictEqual(
			[...collectRelayableCertificates(uncertifiedRows, names, nameToId, () => 2)],
			[
				['peer', { floor: T - 5 }],
				['relayed', { floor: T - 6 }],
			]
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

	it('PendingOriginFloors keeps the level-2 fields a same-floor certificate carries and updates fullCoverage', () => {
		const pending = new PendingOriginFloors();
		pending.note([[7, T, false]]);
		pending.note([[7, T, true, 'gen', true]]);
		pending.note([[7, T, true, 'gen', false]]);
		assert.deepStrictEqual(pending.take(false), [[7, T, true, 'gen', false]]);
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
		assert.deepStrictEqual(rest.originRouteStates, [[3, undefined, false, undefined, 'g3']]);
		assert.strictEqual(pending.size, 0);
		rest.onFailure(new Error('failed'), 1);
		assert.strictEqual(pending.size, 1);
		const retried = {};
		pending.takeInto(retried);
		assert.deepStrictEqual(retried.originRouteStates, [[3, undefined, false, undefined, 'g3']]);
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

	it('PendingOriginFloors lets a generation-stamped certificate replace an unstamped higher floor and clones input tuples', () => {
		const pending = new PendingOriginFloors();
		const first = [7, T, false];
		pending.note([first]);
		pending.note([[7, T, true, 'gen-1', true]]);
		assert.strictEqual(first[2], false, 'caller tuple must not be mutated in place');
		assert.deepStrictEqual(pending.take(false), [[7, T, true, 'gen-1', true]]);

		pending.note([[7, T, false]]);
		pending.note([[7, T - 10, true, 'gen-2', true]]);
		assert.deepStrictEqual(pending.take(false), [[7, T - 10, true, 'gen-2', true]]);
	});

	it('PendingRouteState coalesces marks by originId and orders partialHistory clear before false', () => {
		const state = new PendingRouteState();
		state.certifiedFrom(1, T - 5, 'g1');
		state.partialHistory(1, true);
		// partialHistory(true) on the same origin clears the earlier optimistic certifiedFrom while keeping its generation.
		const ev1 = {};
		state.attachTo(ev1);
		assert.deepStrictEqual(ev1.originRouteStates, [[1, undefined, true, undefined, 'g1']]);

		// Completing a copy in the same batch emits the clear mark first, then partialHistory=false.
		state.partialHistory(1, false, 'g1');
		const ev2 = {};
		state.attachTo(ev2);
		assert.deepStrictEqual(ev2.originRouteStates, [
			[1, undefined, true, undefined, 'g1'],
			[1, undefined, false, undefined, 'g1'],
		]);
	});

	it('PendingRouteState tracks pending revocations and checkpointGradeRow rejects holes, partialHistory, and revocations', () => {
		const state = new PendingRouteState();
		assert.strictEqual(state.hasPendingRevocation(3), false);
		state.revoke(3, 'g3');
		assert.strictEqual(state.hasPendingRevocation(3), true);
		const ev = {};
		state.takeInto(ev);
		assert.deepStrictEqual(ev.originFloorRevocations, [[3, 'g3']]);
		assert.strictEqual(state.hasPendingRevocation(3), false);

		const base = { id: 1, closedFloor: T - 5, originGeneration: 'g1', fullCoverage: true };
		assert.strictEqual(checkpointGradeRow(base), true);
		assert.strictEqual(checkpointGradeRow({ ...base, hole: true }), false);
		assert.strictEqual(checkpointGradeRow({ ...base, partialHistory: true }), false);
		assert.strictEqual(checkpointGradeRow({ ...base, floorRevoked: true }), false);
		assert.strictEqual(checkpointGradeRow({ ...base, fullCoverage: false }), false);
	});

	it('collectRelayableCertificates checks requestedStart against certifiedFrom and requires a numeric certifiedFrom', () => {
		const rows = new Map([
			[
				1,
				{
					seqId: T,
					nodes: [
						{
							id: 1,
							closedFloor: T - 5,
							relayable: true,
							originGeneration: 'gen-1',
							fullCoverage: true,
							certifiedFrom: T - 100,
						},
					],
				},
			],
		]);
		// Without requestedStart, certifiedFrom > 0 withholds level-2 qualifiers.
		assert.deepStrictEqual(collectRelayableCertificates(rows, ['peer'], nameToId, () => 2).get('peer'), {
			floor: T - 5,
		});
		// With requestedStart >= certifiedFrom, the relay scan covers the gap so level-2 qualifiers are forwarded.
		assert.deepStrictEqual(
			collectRelayableCertificates(
				rows,
				['peer'],
				nameToId,
				() => 2,
				() => T - 50
			).get('peer'),
			{ floor: T - 5, generation: 'gen-1', fullCoverage: true }
		);
		// With requestedStart < certifiedFrom, the relay holds a gap below certifiedFrom so only level-1 floor is forwarded.
		assert.deepStrictEqual(
			collectRelayableCertificates(
				rows,
				['peer'],
				nameToId,
				() => 2,
				() => T - 200
			).get('peer'),
			{ floor: T - 5 }
		);
		// When certifiedFrom is unset (undefined), level-2 qualifiers are withheld until a copy or resume establishes certifiedFrom.
		const uncertifiedHistoryRows = new Map([
			[
				1,
				{
					seqId: T,
					nodes: [
						{
							id: 1,
							closedFloor: T - 5,
							relayable: true,
							originGeneration: 'gen-1',
							fullCoverage: true,
						},
					],
				},
			],
		]);
		assert.deepStrictEqual(
			collectRelayableCertificates(
				uncertifiedHistoryRows,
				['peer'],
				nameToId,
				() => 2,
				() => T - 50
			).get('peer'),
			{ floor: T - 5 }
		);
		// When certifiedFrom === 0 (held from genesis), level-2 qualifiers are forwarded even when requestedStart is undefined.
		const fullHistoryRows = new Map([
			[
				1,
				{
					seqId: T,
					nodes: [
						{
							id: 1,
							closedFloor: T - 5,
							relayable: true,
							originGeneration: 'gen-1',
							fullCoverage: true,
							certifiedFrom: 0,
						},
					],
				},
			],
		]);
		assert.deepStrictEqual(
			collectRelayableCertificates(
				fullHistoryRows,
				['peer'],
				nameToId,
				() => 2,
				() => undefined
			).get('peer'),
			{ floor: T - 5, generation: 'gen-1', fullCoverage: true }
		);
	});

	it('PendingOriginFloors restores taken floors on commit failure and detects generation changes across takes', () => {
		const pending = new PendingOriginFloors();
		pending.note([[1, T, true, 'gen-1', true]]);
		const ev1 = {};
		pending.takeForCommit(ev1, false);
		assert.deepStrictEqual(ev1.originFloors, [[1, T, true, 'gen-1', true]]);
		assert.strictEqual(pending.size, 0);

		// Simulate commit failure: floors are restored and merged with any newer notes.
		pending.note([[2, T + 5, false, 'gen-2', false]]);
		ev1.onFailure(new Error('fail'), T);
		assert.strictEqual(pending.size, 2);

		const ev2 = {};
		pending.takeForCommit(ev2, false);
		assert.deepStrictEqual(ev2.originFloors, [
			[1, T, true, 'gen-1', true],
			[2, T + 5, false, 'gen-2', false],
		]);

		// Even after taking gen-1, a lower floor under gen-2 replaces a pending level-1 floor for origin 1.
		pending.note([[1, T + 100, true]]);
		pending.note([[1, T - 50, true, 'gen-2', true]]);
		assert.deepStrictEqual(pending.take(false), [[1, T - 50, true, 'gen-2', true]]);

		// A higher bare level-1 floor replacing a pending level-2 entry drops the level-2 qualifiers.
		pending.note([[1, T, true, 'gen-2', true]]);
		pending.note([[1, T + 10, false]]);
		assert.deepStrictEqual(pending.take(false), [[1, T + 10, false]]);
	});

	it('PendingRouteState ignores certifiedFrom while partialHistory is pending, skips empty remoteNodeIds, and drops settled snapshots across queued events', async () => {
		const state = new PendingRouteState();
		state.partialHistory(1, true, 'g1');
		assert.strictEqual(state.hasPendingPartialHistory(1), true);
		state.certifiedFrom(1, T - 10, 'g1');
		const emptyPeersEvent = { remoteNodeIds: [] };
		state.attachTo(emptyPeersEvent);
		assert.strictEqual(emptyPeersEvent.originRouteStates, undefined);
		assert.strictEqual(state.size, 1);

		const ev1 = { remoteNodeIds: [1] };
		state.attachTo(ev1);
		assert.deepStrictEqual(ev1.originRouteStates, [[1, undefined, true, undefined, 'g1']]);
		assert.strictEqual(state.size, 1, 'marks remain pending until onCommit settles them');

		// Simulate two subsequent events queued before ev1 commits: ev2 restores copy pass in onCommit via takeInto,
		// and ev3 was attached with the stale partialHistory:true snapshot before ev1 or ev2 committed.
		const ev2 = {
			remoteNodeIds: [1],
			onCommit: () => {
				state.partialHistory(1, false, 'g1');
				state.takeInto(ev2);
			},
		};
		state.attachTo(ev2);
		const ev3 = { remoteNodeIds: [1] };
		state.attachTo(ev3);
		assert.deepStrictEqual(ev3.originRouteStates, [[1, undefined, true, undefined, 'g1']]);

		await ev1.onCommit();
		assert.strictEqual(state.size, 0);
		await ev2.onCommit();
		assert.deepStrictEqual(ev2.originRouteStates, [[1, undefined, false, undefined, 'g1']]);
		await ev3.onCommit();
		assert.strictEqual(ev3.originRouteStates, undefined, 'ev3 drops stale partialHistory:true snapshot settled by ev1');
	});

	it('buildOriginCursorVector skips floor-only resume when cursorBelowFloor is at or below minFloorOnlyStart', () => {
		const seqRows = new Map([
			[
				1,
				{
					nodes: [
						{
							id: 2,
							originLogKey: T + 50,
							closedFloor: T + 10,
							originGeneration: 'g-relayed',
							fullCoverage: true,
						},
					],
				},
			],
		]);
		const certified = [];
		const cursors = buildOriginCursorVector(
			seqRows,
			1,
			nameForId,
			isMember,
			true,
			(id, start, gen) => certified.push([id, start, gen]),
			new Map([[2, T + 10]])
		);
		assert.strictEqual(certified.length, 0, 'floor-only resume is suppressed when floor <= maxCopiedVersion');
		assert.strictEqual(cursors.relayed, T + 50);
	});

	it('restoreCompletedCopyPass clears partialHistory without certifying copyStartTime', () => {
		const routeState = new PendingRouteState();
		const partialMarked = new Set([1, 2]);
		routeState.partialHistory(1, true, 'g1');
		routeState.partialHistory(2, true, 'g2');
		const pass = {
			passId: 3,
			startTime: T,
			resumed: false,
			resumedWithWidening: false,
			seqDurableAtCopyStart: true,
			completeReceived: true,
			restored: false,
			originGenerations: new Map([
				[1, 'g1'],
				[2, 'g2'],
			]),
		};
		assert.strictEqual(restoreCompletedCopyPass(pass, 3, partialMarked, routeState), true);
		assert.strictEqual(pass.restored, true);
		assert.strictEqual(partialMarked.size, 0);
		const ev = { remoteNodeIds: [1] };
		routeState.attachTo(ev);
		assert.deepStrictEqual(ev.originRouteStates, [
			[1, undefined, true, undefined, 'g1'],
			[1, undefined, false, undefined, 'g1'],
			[2, undefined, true, undefined, 'g2'],
			[2, undefined, false, undefined, 'g2'],
		]);
	});

	it('restoreCompletedCopyPass preserves pre-existing holes on origins whose partialHistory is cleared', () => {
		const routeState = new PendingRouteState();
		const partialMarked = new Map([
			[1, 'g1'],
			[2, 'g2'],
			[3, 'g3-new'],
		]);
		const pass = {
			passId: 4,
			startTime: T,
			resumed: false,
			resumedWithWidening: false,
			seqDurableAtCopyStart: true,
			completeReceived: true,
			restored: false,
			originGenerations: new Map([
				[1, 'g1'],
				[2, 'g2'],
				[3, 'g3-new'],
			]),
			holedOrigins: new Map([
				[1, 'g1'],
				[3, 'g3-old'],
			]),
		};
		assert.strictEqual(restoreCompletedCopyPass(pass, 4, partialMarked, routeState), true);
		const ev = { remoteNodeIds: [1] };
		routeState.attachTo(ev);
		assert.deepStrictEqual(ev.originRouteStates, [
			[1, undefined, false, true, 'g1'],
			[2, undefined, false, undefined, 'g2'],
			[3, undefined, false, undefined, 'g3-new'],
		]);

		const partialRouteState = new PendingRouteState();
		const partialRouteMarked = new Map([[1, 'g1']]);
		const partialPass = {
			passId: 5,
			startTime: T,
			resumed: false,
			resumedWithWidening: false,
			fullCoverage: false,
			seqDurableAtCopyStart: true,
			completeReceived: true,
			restored: false,
			originGenerations: new Map([[1, 'g1']]),
		};
		assert.strictEqual(restoreCompletedCopyPass(partialPass, 5, partialRouteMarked, partialRouteState), true);
		assert.strictEqual(partialPass.restored, true);
		assert.strictEqual(partialRouteMarked.size, 1);
		assert.strictEqual(partialRouteState.hasPending(), false);
	});

	it('database-wide copyBound suppresses floor-only resume and level-2 relay across peer routes and voids stale [seq, *] certifiedFrom in dbisDB', async () => {
		const store = new Map();
		const keyOf = (k) => JSON.stringify([k[0]?.description ?? String(k[0]), k[1]]);
		const parseKey = (s) => {
			const [symDesc, id] = JSON.parse(s);
			return [Symbol.for(symDesc), id];
		};
		const sharedBuffers = new Map();
		const rootStore = {
			getUserSharedBuffer(name, defaultBuffer) {
				if (!sharedBuffers.has(name)) sharedBuffers.set(name, defaultBuffer);
				return sharedBuffers.get(name);
			},
		};
		const dbisDB = {
			rootStore,
			getSync: (k) => store.get(keyOf(k)),
			put: async (k, v) => {
				store.set(keyOf(k), v);
			},
			getRange({ start }) {
				const prefix = start?.description ?? String(start);
				const out = [];
				for (const [k, v] of store.entries()) {
					const [sym, id] = parseKey(k);
					if (sym.description === prefix) out.push({ key: [sym, id], value: v });
				}
				return out;
			},
		};
		// Disconnected peer 2's persisted [seq, 2] row has certifiedFrom <= T + 800 for origin 2,
		// and certifiedFrom > T + 500 for origin 1 (which should remain intact).
		await dbisDB.put([Symbol.for('seq'), 2], {
			seqId: T,
			nodes: [
				{
					id: 2,
					originLogKey: T + 1000,
					closedFloor: T + 600,
					relayable: true,
					originGeneration: 'g2',
					fullCoverage: true,
					certifiedFrom: T + 100,
				},
				{
					id: 1,
					originLogKey: T + 1000,
					closedFloor: T + 900,
					relayable: true,
					originGeneration: 'g1',
					fullCoverage: true,
					certifiedFrom: T + 700,
				},
			],
		});
		// Copying peer 1's own [seq, 1] row is managed via PendingRouteState on its connection and is not
		// rewritten directly by persistMergedCopyBounds(..., 1).
		await dbisDB.put([Symbol.for('seq'), 1], {
			seqId: T,
			nodes: [{ id: 2, certifiedFrom: T + 100 }],
		});
		// Copy from peer 1 copied origin 2's rows up to T + 800 (keyed under peer 1).
		await persistMergedCopyBounds(dbisDB, new Map([[2, T + 800]]), 1, rootStore);
		assert.strictEqual(dbisDB.getSync([Symbol.for('seq'), 1]).nodes[0].certifiedFrom, T + 100);
		const epochWord = new Int32Array(sharedBuffers.get('origin-state-epoch'));
		assert.strictEqual(Atomics.load(epochWord, 0), 1);
		// Concurrent/later copy from peer 3 copied origin 1's rows up to T + 500 (keyed under peer 3);
		// neither peer's copyBound entry overwrites the other, and peer 3's pass voids peer 1's stale [seq, 1] row.
		await persistMergedCopyBounds(dbisDB, new Map([[1, T + 500]]), 3, rootStore);
		assert.strictEqual(dbisDB.getSync([Symbol.for('seq'), 1]).nodes[0].certifiedFrom, undefined);
		assert.strictEqual(Atomics.load(epochWord, 0), 2);
		assert.deepStrictEqual(dbisDB.getSync([Symbol.for('copyBound'), 1]), { 2: T + 800 });
		assert.deepStrictEqual(dbisDB.getSync([Symbol.for('copyBound'), 3]), { 1: T + 500 });
		const loaded = mergePersistedCopyBounds(new Map(), dbisDB);
		assert.strictEqual(loaded.get(1), T + 500);
		assert.strictEqual(loaded.get(2), T + 800);

		const failingDbis = {
			...dbisDB,
			put(key, val) {
				if (Array.isArray(key) && key[0] === Symbol.for('seq')) {
					return Promise.reject(new Error('simulated seq put failure'));
				}
				return dbisDB.put(key, val);
			},
		};
		await assert.rejects(
			() => persistMergedCopyBounds(failingDbis, new Map([[1, T + 900]]), 3, rootStore),
			/simulated seq put failure/
		);
		assert.strictEqual(
			Atomics.load(epochWord, 0),
			3,
			'origin-state-epoch still bumps in finally when a [seq, *] void write was issued before failure'
		);

		// Persisting the bound voided origin 2's stale certifiedFrom in [seq, 2] on disk, while preserving origin 1's
		// certifiedFrom (T + 700 > T + 500).
		const persistedPeer2Seq = dbisDB.getSync([Symbol.for('seq'), 2]);
		assert.strictEqual(persistedPeer2Seq.nodes.find((n) => n.id === 2).certifiedFrom, undefined);
		assert.strictEqual(persistedPeer2Seq.nodes.find((n) => n.id === 1).certifiedFrom, T + 700);

		const seqRows = new Map([
			[
				1,
				{
					seqId: T,
					nodes: [
						{
							id: 2,
							originLogKey: T + 1000,
							closedFloor: T + 600,
							originGeneration: 'g2',
							fullCoverage: true,
							certifiedFrom: T + 100,
						},
					],
				},
			],
			[2, persistedPeer2Seq],
		]);
		const certified = [];
		const vector = buildOriginCursorVector(
			seqRows,
			1,
			nameForId,
			isMember,
			true,
			(id, start) => certified.push([id, start]),
			loaded
		);
		assert.deepStrictEqual(vector, { relayed: T + 1000 });
		assert.deepStrictEqual(certified, []);

		const relayed = collectRelayableCertificates(
			seqRows,
			['relayed'],
			nameToId,
			() => 2,
			() => T + 200,
			loaded
		);
		assert.deepStrictEqual(relayed.get('relayed'), { floor: T + 600 });

		const failingRangeDbis = {
			...dbisDB,
			getRange(opts) {
				if (opts?.start === Symbol.for('seq')) {
					throw new Error('simulated seq getRange failure');
				}
				return dbisDB.getRange(opts);
			},
		};
		await assert.rejects(
			() => persistMergedCopyBounds(failingRangeDbis, new Map([[1, T + 950]]), 3, rootStore),
			/simulated seq getRange failure/,
			'persistMergedCopyBounds rejects if scanning [seq, *] throws so callers cannot treat un-voided routes as safe'
		);

		let concurrentPutInjected = false;
		const racingDbis = {
			...dbisDB,
			getSync(key) {
				if (!concurrentPutInjected && Array.isArray(key) && key[0] === Symbol.for('seq') && key[1] === 1) {
					concurrentPutInjected = true;
					const cur = dbisDB.getSync(key);
					store.set(keyOf(key), {
						...cur,
						seqId: T + 1234,
						nodes: [{ ...cur.nodes[0], originLogKey: T + 1234, hole: true }],
					});
				}
				return dbisDB.getSync(key);
			},
		};
		await dbisDB.put([Symbol.for('seq'), 1], {
			seqId: T,
			nodes: [{ id: 1, originLogKey: T + 100, certifiedFrom: T + 200, originGeneration: 'g1' }],
		});
		await persistMergedCopyBounds(racingDbis, new Map([[1, T + 960]]), 3, rootStore);
		const racedRow = dbisDB.getSync([Symbol.for('seq'), 1]);
		assert.strictEqual(racedRow.seqId, T + 1234, 'concurrent seqId advance is preserved when voiding certifiedFrom');
		assert.strictEqual(racedRow.nodes[0].originLogKey, T + 1234, 'concurrent originLogKey advance is preserved');
		assert.strictEqual(racedRow.nodes[0].hole, true, 'concurrent hole mark is preserved');
		assert.strictEqual(racedRow.nodes[0].certifiedFrom, undefined, 'certifiedFrom <= bound is voided');
	});

	it('PendingRouteState verifyPersisted restores settled safety marks and revocations if the [seq, peer] write did not persist them', () => {
		const settledEvents = [];
		const routeState = new PendingRouteState((ev) => settledEvents.push(ev));
		routeState.partialHistory(1, true, 'g1');
		routeState.hole(2, 'g2');
		routeState.revoke(3, 'g3');
		routeState.certifiedFrom(4, 100, 'g4');
		const event = { remoteNodeIds: [1] };
		routeState.takeInto(event);
		assert.strictEqual(routeState.hasPending(), false);
		assert.strictEqual(settledEvents.length, 1);
		assert.strictEqual(routeState.hasUnverifiedBatches(), true);

		const unpersistedNodes = [
			{ id: 1, originGeneration: 'g1' },
			{ id: 2, originGeneration: 'g2' },
			{ id: 3, originGeneration: 'g3' },
			{ id: 4, originGeneration: 'g4' },
		];
		assert.strictEqual(routeState.verifyPersisted(unpersistedNodes, event), false);
		assert.strictEqual(routeState.hasPending(), true);
		assert.strictEqual(routeState.hasPendingPartialHistory(1), true);
		assert.strictEqual(routeState.hasPendingRevocation(3), true);

		const retryEvent = { remoteNodeIds: [1] };
		routeState.takeInto(retryEvent);
		assert.deepStrictEqual(retryEvent.originRouteStates, [
			[1, undefined, true, undefined, 'g1'],
			[2, undefined, undefined, true, 'g2'],
		]);
		assert.deepStrictEqual(retryEvent.originFloorRevocations, [[3, 'g3']]);

		const persistedNodes = [
			{ id: 1, originGeneration: 'g1', partialHistory: true },
			{ id: 2, originGeneration: 'g2', hole: true },
			{ id: 3, originGeneration: 'g3', floorRevoked: true },
		];
		assert.strictEqual(routeState.verifyPersisted(persistedNodes, retryEvent), true);
		assert.strictEqual(routeState.hasPending(), false);

		// A pure certifiedFrom clear (partialHistory(true) + partialHistory(false)) whose [seq, peer] write did not
		// clear certifiedFrom restores a two-step clear + restore, and a clear followed by a new certifiedFrom(200)
		// verifies against certifiedFrom: 200 without looping.
		routeState.partialHistory(1, true, 'g1');
		routeState.partialHistory(1, false, 'g1');
		const clearEvent = { remoteNodeIds: [1] };
		routeState.takeInto(clearEvent);
		assert.strictEqual(
			routeState.verifyPersisted(
				[{ id: 1, originGeneration: 'g1', partialHistory: false, certifiedFrom: 100 }],
				clearEvent
			),
			false
		);
		const retryClearEvent = { remoteNodeIds: [1] };
		routeState.takeInto(retryClearEvent);
		assert.deepStrictEqual(retryClearEvent.originRouteStates, [
			[1, undefined, true, undefined, 'g1'],
			[1, undefined, false, undefined, 'g1'],
		]);
		assert.strictEqual(
			routeState.verifyPersisted([{ id: 1, originGeneration: 'g1', partialHistory: false }], retryClearEvent),
			true
		);

		routeState.partialHistory(1, true, 'g1');
		routeState.partialHistory(1, false, 'g1');
		routeState.certifiedFrom(1, 200, 'g1');
		const recertEvent = { remoteNodeIds: [1] };
		routeState.takeInto(recertEvent);
		assert.strictEqual(
			routeState.verifyPersisted(
				[{ id: 1, originGeneration: 'g1', partialHistory: false, certifiedFrom: 200 }],
				recertEvent
			),
			true
		);
		assert.strictEqual(routeState.hasUnverifiedBatches(), false);

		// When a copyBound void clears certifiedFrom between settle and read-back, verifyPersisted accepts
		// certifiedFrom === undefined without re-queuing the positive S.
		routeState.partialHistory(1, true, 'g1');
		routeState.partialHistory(1, false, 'g1');
		routeState.certifiedFrom(1, 200, 'g1');
		const voidedEvent = { remoteNodeIds: [1] };
		routeState.takeInto(voidedEvent);
		assert.strictEqual(
			routeState.verifyPersisted([{ id: 1, originGeneration: 'g1', partialHistory: false }], voidedEvent),
			true
		);
		assert.strictEqual(routeState.hasUnverifiedBatches(), false);
		assert.strictEqual(routeState.hasPending(), false);
	});

	it('clearGenlessClosedFloorOnSeqRow awaits [seq, peer] put and clears closedFloor and relayable only on genless nodes', async () => {
		const store = new Map();
		const keyOf = (k) => JSON.stringify([k[0]?.description ?? String(k[0]), k[1]]);
		const sharedBuffers = new Map();
		const rootStore = {
			getUserSharedBuffer(name, defaultBuffer) {
				if (!sharedBuffers.has(name)) sharedBuffers.set(name, defaultBuffer);
				return sharedBuffers.get(name);
			},
		};
		const dbisDB = {
			rootStore,
			getSync: (k) => store.get(keyOf(k)),
			put: async (k, v) => {
				store.set(keyOf(k), v);
			},
		};
		await dbisDB.put([Symbol.for('seq'), 1], {
			seqId: T,
			nodes: [
				{ id: 2, originLogKey: T + 500, closedFloor: T + 300, relayable: true },
				{ id: 3, originLogKey: T + 500, closedFloor: T + 300, relayable: true, originGeneration: 'g3' },
			],
		});
		assert.strictEqual(await clearGenlessClosedFloorOnSeqRow(dbisDB, 1, 2, rootStore), true);
		const updated = dbisDB.getSync([Symbol.for('seq'), 1]);
		assert.strictEqual(updated.nodes[0].closedFloor, undefined);
		assert.strictEqual(updated.nodes[0].relayable, false);
		assert.strictEqual(updated.nodes[1].closedFloor, T + 300);
		assert.strictEqual(updated.nodes[1].relayable, true);
	});
});
