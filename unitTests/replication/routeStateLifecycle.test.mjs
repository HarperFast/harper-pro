import assert from 'node:assert';
import {
	PendingOriginFloors,
	PendingRouteState,
	copyPassRouteRestored,
	restoreCompletedCopyPass,
	scanCopyBounds,
} from '#src/replication/replicationConnection';

const T = 1_790_000_000_000;

describe('route-state facts keyed by generation and connection (harper-pro#1145)', () => {
	it('verifies a mark against the generation core matches it to, lastGeneration included', () => {
		const routeState = new PendingRouteState(() => {});
		routeState.partialHistory(1, true, 'g1');
		const event = { remoteNodeIds: [1] };
		routeState.takeInto(event);
		// a level-1 certificate moved the row's generation to lastGeneration, where core still applies the mark
		assert.strictEqual(
			routeState.verifyPersisted(() => [{ id: 1, lastGeneration: 'g1' }], event),
			false
		);
		assert.strictEqual(routeState.hasPendingPartialHistory(1), true);
		// a node the row never held is one core would not create for a generation-stamped mark
		const absent = { remoteNodeIds: [1] };
		routeState.takeInto(absent);
		assert.strictEqual(
			routeState.verifyPersisted(() => [], absent),
			true
		);
	});

	it('does not restore an earlier partialHistory over a later settled value', () => {
		const routeState = new PendingRouteState(() => {});
		routeState.partialHistory(1, true, 'g1');
		const marked = { remoteNodeIds: [1] };
		routeState.takeInto(marked);
		// a completed copy's restoration settles before the earlier mark's check runs
		routeState.partialHistory(1, false, 'g1');
		const restored = { remoteNodeIds: [1] };
		routeState.takeInto(restored);
		const row = [{ id: 1, originGeneration: 'g1', partialHistory: false }];
		assert.strictEqual(
			routeState.verifyPersisted(() => row, marked),
			true
		);
		assert.strictEqual(routeState.hasPending(), false);
		// a hole in the earlier batch is still checked
		routeState.hole(2, 'g2');
		routeState.partialHistory(2, true, 'g2');
		const holed = { remoteNodeIds: [1] };
		routeState.takeInto(holed);
		routeState.partialHistory(2, false, 'g2');
		routeState.takeInto({ remoteNodeIds: [1] });
		assert.strictEqual(
			routeState.verifyPersisted(() => [{ id: 2, originGeneration: 'g2', partialHistory: false }], holed),
			false
		);
	});

	it('retries an unpersisted certification only on the request that earned it, and never over a newer clear', async () => {
		const routeState = new PendingRouteState(() => {});
		routeState.certifiedFrom(4, 100, 'g4');
		const certified = { remoteNodeIds: [1] };
		routeState.takeInto(certified);
		routeState.partialHistory(4, true, 'g4');
		routeState.partialHistory(4, false, 'g4');
		const cleared = { remoteNodeIds: [1] };
		routeState.takeInto(cleared);
		const row = [{ id: 4, originGeneration: 'g4', partialHistory: false }];
		assert.strictEqual(
			routeState.verifyPersisted(() => row, certified),
			true,
			'the clear that voided it settled since'
		);
		assert.strictEqual(
			routeState.verifyPersisted(() => row, cleared),
			true
		);
		assert.strictEqual(routeState.hasPending(), false);

		// a transaction failing after a new request stripped certification brings back only what is safe
		const failing = new PendingRouteState();
		failing.certifiedFrom(5, 200, 'g5');
		failing.hole(6, 'g6');
		const event = { remoteNodeIds: [1] };
		failing.attachTo(event);
		await event.onCommit();
		failing.retainOnlySafetyMarks();
		event.onFailure(new Error('commit failed'), 0);
		const retry = { remoteNodeIds: [1] };
		failing.attachTo(retry);
		assert.deepStrictEqual(retry.originRouteStates, [[6, undefined, undefined, true, 'g6']]);

		// the same request's failure brings the certification back
		const sameRequest = new PendingRouteState();
		sameRequest.certifiedFrom(5, 200, 'g5');
		const first = { remoteNodeIds: [1] };
		sameRequest.attachTo(first);
		await first.onCommit();
		first.onFailure(new Error('commit failed'), 0);
		const again = { remoteNodeIds: [1] };
		sameRequest.attachTo(again);
		assert.deepStrictEqual(again.originRouteStates, [[5, 200, undefined, undefined, 'g5']]);
	});

	it('restores a failed batch without a partialHistory a later settle replaced', () => {
		const routeState = new PendingRouteState(() => {});
		routeState.partialHistory(1, true, 'g1');
		routeState.hole(2, 'g2');
		const first = { remoteNodeIds: [1] };
		routeState.takeInto(first);
		routeState.partialHistory(1, false, 'g1');
		routeState.takeInto({ remoteNodeIds: [1] });
		const row = [
			{ id: 1, originGeneration: 'g1', partialHistory: false },
			{ id: 2, originGeneration: 'g2' },
		];
		assert.strictEqual(
			routeState.verifyPersisted(() => row, first),
			false,
			'the hole did not land'
		);
		assert.strictEqual(routeState.hasPendingPartialHistory(1), false);
		const retry = { remoteNodeIds: [1] };
		routeState.takeInto(retry);
		assert.deepStrictEqual(retry.originRouteStates, [[2, undefined, undefined, true, 'g2']]);
	});

	it('does not retry a certification on a row that cannot hold one', () => {
		for (const node of [
			{ id: 4, originGeneration: 'g4', floorRevoked: true },
			// a partial-coverage certificate cleared it
			{ id: 4, originGeneration: 'g4', fullCoverage: false },
			// a level-1 certificate moved the generation and cleared it
			{ id: 4, lastGeneration: 'g4' },
		]) {
			const routeState = new PendingRouteState(() => {});
			routeState.certifiedFrom(4, 100, 'g4');
			const event = { remoteNodeIds: [1] };
			routeState.takeInto(event);
			assert.strictEqual(
				routeState.verifyPersisted(() => [node], event),
				true,
				JSON.stringify(node)
			);
			assert.strictEqual(routeState.hasPending(), false);
		}
	});

	it('rolls back a failed batch’s settles only where no later settle replaced them', () => {
		const routeState = new PendingRouteState(() => {});
		routeState.partialHistory(1, true, 'g1');
		routeState.hole(2, 'g2');
		const first = { remoteNodeIds: [1] };
		routeState.takeInto(first);
		routeState.certifiedFrom(1, 100, 'g1');
		routeState.hole(3, 'g3');
		const certified = { remoteNodeIds: [1] };
		routeState.takeInto(certified);
		routeState.partialHistory(1, true, 'g1');
		routeState.partialHistory(1, false, 'g1');
		routeState.takeInto({ remoteNodeIds: [1] });
		const row = [
			{ id: 1, originGeneration: 'g1', partialHistory: false },
			{ id: 2, originGeneration: 'g2' },
			{ id: 3, originGeneration: 'g3' },
		];
		assert.strictEqual(
			routeState.verifyPersisted(() => row, first),
			false,
			'the hole did not land'
		);
		assert.strictEqual(
			routeState.verifyPersisted(() => row, certified),
			false
		);
		const retry = { remoteNodeIds: [1] };
		routeState.takeInto(retry);
		// the clear that settled after the certification still voids it, though an older batch's clear rolled back
		assert.deepStrictEqual(retry.originRouteStates, [
			[2, undefined, undefined, true, 'g2'],
			[3, undefined, undefined, true, 'g3'],
		]);
	});

	it('retries a failed batch without a certification the row can no longer take', () => {
		for (const node of [
			{ id: 1, lastGeneration: 'g1' },
			{ id: 1, originGeneration: 'g1', fullCoverage: false },
		]) {
			const routeState = new PendingRouteState(() => {});
			routeState.certifiedFrom(1, 100, 'g1');
			routeState.hole(2, 'g2');
			const event = { remoteNodeIds: [1] };
			routeState.takeInto(event);
			assert.strictEqual(
				routeState.verifyPersisted(() => [node, { id: 2, originGeneration: 'g2' }], event),
				false
			);
			const retry = { remoteNodeIds: [1] };
			routeState.takeInto(retry);
			assert.deepStrictEqual(retry.originRouteStates, [[2, undefined, undefined, true, 'g2']], JSON.stringify(node));
		}
	});

	it('keeps a clear coalesced with a refused certification in the retry, less the certification', () => {
		const routeState = new PendingRouteState(() => {});
		routeState.partialHistory(1, true, 'g1');
		routeState.partialHistory(1, false, 'g1');
		routeState.certifiedFrom(1, 100, 'g1');
		routeState.hole(2, 'g2');
		const event = { remoteNodeIds: [1] };
		routeState.takeInto(event);
		const row = [
			{ id: 1, originGeneration: 'g1', fullCoverage: false },
			{ id: 2, originGeneration: 'g2' },
		];
		assert.strictEqual(
			routeState.verifyPersisted(() => row, event),
			false
		);
		const retry = { remoteNodeIds: [1] };
		routeState.takeInto(retry);
		assert.ok(
			retry.originRouteStates.every(([id, certifiedFrom]) => id !== 1 || certifiedFrom === undefined),
			JSON.stringify(retry.originRouteStates)
		);
		assert.ok(retry.originRouteStates.some(([id, , partialHistory]) => id === 1 && partialHistory === false));
		assert.ok(retry.originRouteStates.some(([id, , , hole]) => id === 2 && hole === true));
	});

	it('writes no certification captured before a new request when its commit runs after it', async () => {
		const routeState = new PendingRouteState();
		routeState.certifiedFrom(5, 200, 'g5');
		routeState.hole(6, 'g6');
		const event = { remoteNodeIds: [1] };
		routeState.attachTo(event);
		routeState.retainOnlySafetyMarks();
		await event.onCommit();
		assert.deepStrictEqual(event.originRouteStates, [[6, undefined, undefined, true, 'g6']]);
	});

	it('restores a failed commit’s floors except one revoked or re-generated since the take', () => {
		const revoked = new PendingOriginFloors();
		revoked.note([[2, T, true, 'g2', true]]);
		const event = {};
		revoked.takeForCommit(event, false);
		revoked.drop(2);
		event.onFailure(new Error('commit failed'), 0);
		assert.strictEqual(revoked.size, 0);

		const regenerated = new PendingOriginFloors();
		regenerated.note([[2, T + 500, true]]);
		const taken = {};
		regenerated.takeForCommit(taken, false);
		regenerated.note([[2, T, true, 'g2', true]]);
		taken.onFailure(new Error('commit failed'), 0);
		const next = {};
		regenerated.takeForCommit(next, false);
		assert.deepStrictEqual(next.originFloors, [[2, T, true, 'g2', true]]);

		const unchanged = new PendingOriginFloors();
		unchanged.note([[3, T, true, 'g3', true]]);
		const kept = {};
		unchanged.takeForCommit(kept, false);
		unchanged.drop(9);
		kept.onFailure(new Error('commit failed'), 0);
		assert.strictEqual(unchanged.size, 1);
	});
});

describe('copy-pass completion (harper-pro#1146, #1143)', () => {
	const completedPass = (overrides) => ({
		passId: 1,
		startTime: T,
		resumed: false,
		resumedWithWidening: false,
		seqDurableAtCopyStart: true,
		completeReceived: true,
		finalized: true,
		restored: false,
		marksRoute: true,
		originGenerations: new Map([[1, 'g1']]),
		...overrides,
	});

	it('restores whole history only once the copy has finalized', () => {
		const routeState = new PendingRouteState();
		const partialMarked = new Map([[1, 'g1']]);
		const pass = completedPass({ finalized: false });
		assert.strictEqual(restoreCompletedCopyPass(pass, 1, partialMarked, routeState), false);
		assert.strictEqual(routeState.hasPending(), false);
		assert.strictEqual(partialMarked.size, 1);
		pass.finalized = true;
		assert.strictEqual(restoreCompletedCopyPass(pass, 1, partialMarked, routeState), true);
		assert.strictEqual(partialMarked.size, 0);
		assert.strictEqual(routeState.hasPending(), true);
	});

	it('marks nothing for a pass on a link below level 2', () => {
		const routeState = new PendingRouteState();
		const partialMarked = new Map([[1, 'g1']]);
		const pass = completedPass({ marksRoute: false });
		assert.strictEqual(restoreCompletedCopyPass(pass, 1, partialMarked, routeState), true);
		assert.strictEqual(pass.restored, true);
		assert.strictEqual(routeState.hasPending(), false);
	});

	it('removes the cursor once present origins are restored, whatever the row lacks', () => {
		const pass = {
			originGenerations: new Map([
				[1, 'g1'],
				[2, undefined],
				[3, 'g3'],
			]),
		};
		// origin 3 never got a node: it holds no partial claim, and a generation-stamped restore could not create one
		assert.deepStrictEqual(
			copyPassRouteRestored(
				pass,
				[
					{ id: 1, originGeneration: 'g1', partialHistory: false, fullCoverage: false },
					{ id: 2, partialHistory: false },
				],
				new Map()
			),
			{ restored: true, requeue: [] }
		);
		assert.deepStrictEqual(
			copyPassRouteRestored(
				pass,
				[
					{ id: 1, lastGeneration: 'g1', partialHistory: true },
					{ id: 2, partialHistory: false },
				],
				new Map()
			),
			{ restored: false, requeue: [[1, 'g1']] }
		);
		assert.deepStrictEqual(
			copyPassRouteRestored(pass, [{ id: 1, originGeneration: 'g9', partialHistory: true }], new Map()),
			{ restored: true, requeue: [] },
			'a rotated origin is not this pass’s to restore'
		);
		assert.strictEqual(copyPassRouteRestored(pass, [], new Map([[2, undefined]])).restored, false);
		assert.strictEqual(copyPassRouteRestored(pass, undefined, new Map()).restored, false, 'an unread row holds it');
		assert.strictEqual(copyPassRouteRestored({ originGenerations: new Map() }, undefined, new Map()).restored, true);
	});
});

describe('copy-bound load (harper-pro#1149)', () => {
	function boundStore(rows) {
		let scans = 0;
		return {
			scans: () => scans,
			getRange() {
				scans++;
				return rows.map(([key, value]) => ({ key: [Symbol.for('copyBound'), ...key], value }));
			},
		};
	}

	it('builds the merged and committed views from one scan', () => {
		const dbisDB = boundStore([
			[[1], { 2: T + 100 }],
			[[1, 'reserved', 'p1'], { 2: T + 300, 3: T + 50 }],
			[[1, 'reserved', 'p0'], { 2: T + 400 }],
			[[5, 'hole', 'p9', 1, T], { 2: T + 999_999 }],
		]);
		const { merged, committed, malformed } = scanCopyBounds(dbisDB, 1, 'p1');
		assert.strictEqual(dbisDB.scans(), 1);
		assert.strictEqual(malformed, undefined);
		assert.deepStrictEqual(
			[...merged].sort(),
			[
				[2, T + 400],
				[3, T + 50],
			],
			'holes stay out of what a pass reserves'
		);
		assert.deepStrictEqual(
			[...committed].sort(),
			[
				[2, T + 300],
				[3, T + 50],
			],
			'another attempt’s reservation, which its settle drops, is not committed'
		);
	});

	it('keeps a malformed row’s valid keys in the merged view and reports it', () => {
		const dbisDB = boundStore([
			[[4], { 2: 'x', 3: T + 10 }],
			[[1, 'reserved', 'p1'], { 2: T + 300 }],
		]);
		const { merged, malformed } = scanCopyBounds(dbisDB, 1, 'p1');
		assert.strictEqual(merged.get(3), T + 10);
		assert.strictEqual(merged.get(2), T + 300, 'a row after the malformed one still counts');
		assert.strictEqual(malformed?.statusCode, 410);
	});
});
