/**
 * Contract of the cross-reconnect blob-gap escalation budget (harper-pro#432; policy in
 * replication/DESIGN.md item 8): one charge per socket generation, the two bounds, resolve-resets,
 * stickiness (the leapfrog guard), generation fencing, retirement, and the capacity policy.
 */

import assert from 'node:assert';
import {
	createBlobGapEscalationBudget,
	blobGapDeliveryKey,
	describeBlobGapEscalation,
	nonNegativeIntegerOr,
	markSourceBlobStatus,
	isBudgetedSourceBlobError,
	markSourceBlobUnavailable,
	isUnrecoverableSourceBlobError,
	getBlobGapEscalation,
	BLOB_GAP_BUDGET_MAX_TRACKED,
} from '#src/replication/replicationConnection';

function fakeClock(start = 0) {
	let t = start;
	return {
		now: () => t,
		tick(ms) {
			t += ms;
		},
	};
}

const A = blobGapDeliveryKey('a1', 1);
const B = blobGapDeliveryKey('b2', 2);

describe('createBlobGapEscalationBudget (#432)', () => {
	it('charges one cycle per socket generation, however many times a delivery fails in it', () => {
		const clock = fakeClock();
		const budget = createBlobGapEscalationBudget({ maxCycles: 3, maxHoldMs: 0, now: clock.now });
		assert.equal(budget.charge(A, 1), undefined);
		assert.equal(budget.charge(A, 1), undefined);
		assert.equal(budget.charge(A, 1), undefined);
		assert.equal(budget.charge(A, 2), undefined);
		assert.equal(budget.charge(A, 2), undefined);
		assert.deepEqual(budget.charge(A, 3), { cycles: 3, heldMs: 0 });
	});

	it('trips on the cycle bound after maxCycles distinct generations', () => {
		const budget = createBlobGapEscalationBudget({ maxCycles: 2, maxHoldMs: 0, now: fakeClock().now });
		assert.equal(budget.charge(A, 1), undefined);
		assert.equal(budget.charge(A, 2).cycles, 2);
	});

	it('trips on the wall-clock bound first when the hold outlives maxHoldMs', () => {
		const clock = fakeClock(5_000);
		const budget = createBlobGapEscalationBudget({ maxCycles: 10, maxHoldMs: 1_000, now: clock.now });
		assert.equal(budget.charge(A, 1), undefined);
		clock.tick(999);
		assert.equal(budget.charge(A, 2), undefined);
		clock.tick(1);
		assert.deepEqual(budget.charge(A, 3), { cycles: 3, heldMs: 1_000 });
	});

	it('a successful save before exhaustion resets both the cycle count and the first-held time', () => {
		const clock = fakeClock();
		const budget = createBlobGapEscalationBudget({ maxCycles: 3, maxHoldMs: 10_000, now: clock.now });
		budget.charge(A, 1);
		clock.tick(9_000);
		budget.charge(A, 2);
		budget.resolve(A, 2);
		assert.equal(budget.size, 0);
		clock.tick(5_000); // 14s since the original first hold: only a stale firstHeldAt would trip now
		assert.equal(budget.charge(A, 3), undefined);
		assert.equal(budget.charge(A, 4), undefined);
		assert.equal(budget.charge(A, 5).cycles, 3);
	});

	it('budgets deliveries independently — a fresh delivery in the Nth cycle starts at one', () => {
		const budget = createBlobGapEscalationBudget({ maxCycles: 3, maxHoldMs: 0, now: fakeClock().now });
		budget.charge(A, 1);
		budget.charge(A, 2);
		assert.equal(budget.charge(A, 3).cycles, 3);
		assert.equal(budget.charge(B, 3), undefined);
		assert.equal(budget.charge(B, 4), undefined);
		assert.equal(budget.charge(B, 5).cycles, 3);
	});

	it('is sticky once exhausted: every later hold escalates at once until a save resolves it', () => {
		const budget = createBlobGapEscalationBudget({ maxCycles: 2, maxHoldMs: 0, now: fakeClock().now });
		budget.charge(A, 1);
		assert.equal(budget.charge(A, 2).cycles, 2);
		assert.equal(budget.charge(A, 3).cycles, 3);
		assert.equal(budget.charge(A, 7).cycles, 4);
		budget.resolve(A, 7);
		assert.equal(budget.charge(A, 8), undefined);
	});

	it('two deliveries with offset phases converge instead of leapfrogging forever', () => {
		// Without stickiness: A escalates in gen 3 and is forgotten while B still holds; gen 4 re-streams A,
		// which starts over while B escalates and is forgotten; and so on — the cursor never advances.
		const budget = createBlobGapEscalationBudget({ maxCycles: 3, maxHoldMs: 0, now: fakeClock().now });
		const holds = [];
		for (let generation = 1; generation <= 6; generation++) {
			const held = [];
			if (!budget.charge(A, generation)) held.push('A');
			if (generation >= 2 && !budget.charge(B, generation)) held.push('B');
			holds.push(held.join('') || '-');
		}
		assert.deepEqual(holds, ['A', 'AB', 'B', '-', '-', '-']);
	});

	it('ignores charges and resolves from a retired socket generation', () => {
		const budget = createBlobGapEscalationBudget({ maxCycles: 2, maxHoldMs: 0, now: fakeClock().now });
		budget.charge(A, 2);
		assert.equal(budget.charge(A, 1), undefined); // stale: not counted
		budget.resolve(A, 1); // stale: not cleared
		assert.equal(budget.size, 1);
		assert.equal(budget.charge(A, 3).cycles, 2);
	});

	it('beginGeneration retires the previous socket before it settles anything else', () => {
		// A replacement socket announces itself before its first blob settles, so the retired socket's late
		// successful save (which would otherwise erase live progress) is already stale.
		const budget = createBlobGapEscalationBudget({ maxCycles: 3, maxHoldMs: 0, now: fakeClock().now });
		budget.charge(A, 1);
		budget.beginGeneration(2);
		budget.resolve(A, 1);
		assert.equal(budget.size, 1);
		assert.equal(budget.charge(A, 1), undefined);
		assert.equal(budget.charge(A, 2), undefined);
		assert.equal(budget.charge(A, 3).cycles, 3);
		budget.beginGeneration(2); // never moves backwards
		assert.equal(budget.charge(A, 3).cycles, 3);
	});

	it('at capacity with every tracked delivery live, a new hold shares the capacity cohort budget, warned once per generation', () => {
		const warnings = [];
		const budget = createBlobGapEscalationBudget({
			maxCycles: 2,
			maxHoldMs: 0,
			maxTracked: 2,
			now: fakeClock().now,
			onCapacity: (tracked) => warnings.push(tracked),
		});
		budget.charge(A, 1);
		budget.charge(B, 1);
		const C = blobGapDeliveryKey('c3', 3);
		assert.equal(budget.charge(C, 1), undefined);
		assert.equal(budget.charge(C, 1), undefined);
		assert.equal(budget.size, 2);
		assert.deepEqual(warnings, [2]);
		assert.deepEqual(budget.charge(C, 2), { cycles: 2, heldMs: 0, cohort: true });
		assert.deepEqual(warnings, [2, 2]);
	});

	it('cap-plus-one persistent gaps still reach a gap-free generation', () => {
		// Without the cohort, the untracked gap would rotate with the tracked ones forever: each generation
		// one of them is re-held under a fresh budget and pins the cursor.
		const budget = createBlobGapEscalationBudget({ maxCycles: 2, maxHoldMs: 0, maxTracked: 2, now: fakeClock().now });
		const C = blobGapDeliveryKey('c3', 3);
		const holds = [];
		for (let generation = 1; generation <= 4; generation++) {
			budget.beginGeneration(generation);
			const held = [];
			for (const [name, key] of [
				['A', A],
				['B', B],
				['C', C],
			])
				if (!budget.charge(key, generation)) held.push(name);
			holds.push(held.join('') || '-');
		}
		assert.deepEqual(holds, ['ABC', '-', '-', '-']);
	});

	it('at capacity displaces an exhausted entry the current socket has not re-held, keeping re-held ones sticky', () => {
		const budget = createBlobGapEscalationBudget({ maxCycles: 1, maxHoldMs: 0, maxTracked: 2, now: fakeClock().now });
		assert.equal(budget.charge(A, 1).cycles, 1);
		assert.equal(budget.charge(B, 1).cycles, 1);
		const C = blobGapDeliveryKey('c3', 3);
		budget.beginGeneration(2);
		assert.equal(budget.charge(A, 2).cycles, 2);
		assert.equal(budget.charge(C, 2).cycles, 1);
		assert.equal(budget.size, 2);
		assert.deepEqual(budget.charge(B, 2), { cycles: 1, heldMs: 0, cohort: true });
	});

	it('a lazily created budget starts at the connection generation, so a retired socket cannot seed it', () => {
		const budget = createBlobGapEscalationBudget({ maxCycles: 1, maxHoldMs: 0, now: fakeClock().now, generation: 2 });
		assert.equal(budget.charge(A, 1), undefined);
		assert.equal(budget.size, 0);
		assert.equal(budget.charge(A, 2).cycles, 1);
	});

	it('a throwing onCapacity callback is absorbed', () => {
		const budget = createBlobGapEscalationBudget({
			maxCycles: 3,
			maxHoldMs: 0,
			maxTracked: 1,
			now: fakeClock().now,
			onCapacity: () => {
				throw new Error('boom');
			},
		});
		budget.charge(A, 1);
		assert.equal(budget.charge(B, 1), undefined);
		assert.equal(budget.size, 1);
	});

	it('retires any entry unseen for two active socket generations, exhausted or live', () => {
		const budget = createBlobGapEscalationBudget({ maxCycles: 2, maxHoldMs: 0, now: fakeClock().now });
		const C = blobGapDeliveryKey('c3', 3);
		budget.charge(A, 1);
		budget.charge(B, 1);
		budget.charge(A, 2); // A exhausted at generation 2; B live, last held in generation 1
		budget.beginGeneration(3);
		budget.charge(C, 3); // generation 3 is active
		budget.beginGeneration(4);
		assert.equal(budget.size, 2); // B silent for active generations 2 and 3: retired; A and C kept
		budget.charge(C, 4);
		budget.beginGeneration(5);
		assert.equal(budget.size, 1); // A silent for active generations 3 and 4: retired
		assert.equal(budget.charge(A, 5), undefined); // re-held after retirement: a fresh budget
	});

	it('sockets that settle nothing do not count toward retirement', () => {
		// A peer in a restart loop, or a copy the watchdogs keep terminating, burns generations without
		// re-streaming the held delivery; its clock must survive that.
		const clock = fakeClock();
		const budget = createBlobGapEscalationBudget({ maxCycles: 100, maxHoldMs: 10_000, now: clock.now });
		budget.charge(A, 1);
		for (let generation = 2; generation <= 12; generation++) budget.beginGeneration(generation);
		assert.equal(budget.size, 1);
		clock.tick(10_000);
		assert.equal(budget.charge(A, 12).cycles, 2); // wall-clock bound from the original first hold
	});

	it('keeps an exhausted delivery that is still re-streamed every generation', () => {
		const budget = createBlobGapEscalationBudget({ maxCycles: 1, maxHoldMs: 0, now: fakeClock().now });
		assert.equal(budget.charge(A, 1).cycles, 1);
		for (let generation = 2; generation <= 8; generation++) {
			budget.beginGeneration(generation);
			assert.equal(budget.size, 1);
			assert.equal(budget.charge(A, generation).cycles, generation);
		}
	});

	it('with both bounds disabled a tracked delivery never escalates', () => {
		const budget = createBlobGapEscalationBudget({ maxCycles: 0, maxHoldMs: 0, now: fakeClock().now });
		for (let generation = 1; generation <= 50; generation++) assert.equal(budget.charge(A, generation), undefined);
	});

	it('resolve is a safe no-op for an empty budget or an unknown delivery', () => {
		const budget = createBlobGapEscalationBudget({ maxCycles: 1, maxHoldMs: 0, now: fakeClock().now });
		budget.resolve(A, 1);
		budget.charge(B, 1);
		budget.resolve(A, 1);
		assert.equal(budget.size, 1);
	});

	it('uses a monotonic clock and the production cap by default', () => {
		const budget = createBlobGapEscalationBudget({ maxCycles: 1, maxHoldMs: 0 });
		const escalation = budget.charge(blobGapDeliveryKey(undefined, undefined), 1);
		assert.equal(escalation.cycles, 1);
		assert.ok(escalation.heldMs >= 0 && escalation.heldMs < 1_000);
		assert.equal(BLOB_GAP_BUDGET_MAX_TRACKED, 10_000);
	});
});

describe('blobGapDeliveryKey', () => {
	it('distinguishes two records that share one source file id', () => {
		assert.notEqual(blobGapDeliveryKey('f1', 1), blobGapDeliveryKey('f1', 2));
		assert.equal(blobGapDeliveryKey('f1', 1), blobGapDeliveryKey('f1', 1));
		assert.notEqual(blobGapDeliveryKey('f1', 'k'), blobGapDeliveryKey('f2', 'k'));
	});

	it('separates the same record id in different tables', () => {
		assert.notEqual(blobGapDeliveryKey('f1', 1, 'a'), blobGapDeliveryKey('f1', 1, 'b'));
		assert.equal(blobGapDeliveryKey('f1', 1, 'a'), blobGapDeliveryKey('f1', 1, 'a'));
		assert.equal(blobGapDeliveryKey('f1', 'k', 't'), 'f1|t|s1:k');
	});

	it('never throws and keeps types apart', () => {
		assert.doesNotThrow(() => blobGapDeliveryKey('f1', [1n, 2n]));
		assert.notEqual(blobGapDeliveryKey('f1', [1n]), blobGapDeliveryKey('f1', [2n]));
		assert.notEqual(blobGapDeliveryKey('f1', 1), blobGapDeliveryKey('f1', '1'));
		assert.notEqual(blobGapDeliveryKey('f1', 1n), blobGapDeliveryKey('f1', 1));
		assert.doesNotThrow(() => blobGapDeliveryKey('f1', undefined));
		assert.doesNotThrow(() => blobGapDeliveryKey('f1', null));
		assert.doesNotThrow(() => blobGapDeliveryKey('f1', Symbol('k')));
		const cyclic = {};
		cyclic.self = cyclic;
		assert.doesNotThrow(() => blobGapDeliveryKey('f1', cyclic));
		assert.notEqual(blobGapDeliveryKey('f1', ['a,s1:b']), blobGapDeliveryKey('f1', ['a', 'b']));
		assert.notEqual(blobGapDeliveryKey('f1', { 'a=1': 2 }), blobGapDeliveryKey('f1', { a: '1=2' }));
	});

	it('does not collapse structured record ids', () => {
		assert.notEqual(blobGapDeliveryKey('f1', { a: 1 }), blobGapDeliveryKey('f1', { a: 2 }));
		assert.notEqual(blobGapDeliveryKey('f1', [1, 2]), blobGapDeliveryKey('f1', [1, 3]));
		assert.notEqual(blobGapDeliveryKey('f1', Buffer.from([1])), blobGapDeliveryKey('f1', Buffer.from([2])));
		assert.equal(blobGapDeliveryKey('f1', [1, 2]), blobGapDeliveryKey('f1', [1, 2]));
	});
});

describe('describeBlobGapEscalation', () => {
	const limits = { maxCycles: 10, maxHoldMs: 1_800_000 };

	it('names the exhausted budget, its spend, and its limits', () => {
		const text = describeBlobGapEscalation({ cycles: 3, heldMs: 6_500.4 }, limits);
		assert.ok(!text.includes('capacity'), text);
		assert.ok(
			text.includes('blob-gap escalation budget exhausted after 3 reconnect cycle(s) holding it for 6500ms'),
			text
		);
		assert.ok(text.includes('10 cycles / 1800000 ms'), text);
	});

	it('names a cohort escalation', () => {
		const text = describeBlobGapEscalation({ cycles: 3, heldMs: 0, cohort: true }, limits);
		assert.ok(text.includes('shared capacity budget'), text);
	});

	it('reports a disabled bound as "no"', () => {
		const text = describeBlobGapEscalation({ cycles: 2, heldMs: 0 }, { ...limits, maxHoldMs: 0 });
		assert.ok(text.includes('10 cycles / no ms'), text);
	});
});

describe('nonNegativeIntegerOr — escalation bound config parsing', () => {
	it('keeps an explicit 0 (the documented disable)', () => {
		assert.equal(nonNegativeIntegerOr(0, 10), 0);
		assert.equal(nonNegativeIntegerOr('0', 10), 0);
	});

	it('floors fractions and accepts numeric strings', () => {
		assert.equal(nonNegativeIntegerOr('7.9', 10), 7);
		assert.equal(nonNegativeIntegerOr(12, 10), 12);
	});

	it('falls back for unset, empty, non-numeric, negative, and infinite values', () => {
		for (const value of [undefined, null, '', 'abc', -1, '-5', Infinity, 'Infinity', NaN]) {
			assert.equal(nonNegativeIntegerOr(value, 10), 10, String(value));
		}
	});
});

describe('source-blob status classification for the budget (#432)', () => {
	it('budgets only a source-reported 503', () => {
		assert.equal(isBudgetedSourceBlobError(markSourceBlobStatus(new Error('x'), 503)), true);
		assert.equal(isBudgetedSourceBlobError(markSourceBlobStatus(new Error('x'), 404)), false);
		assert.equal(isBudgetedSourceBlobError(markSourceBlobStatus(new Error('x'), '503')), false);
		assert.equal(isBudgetedSourceBlobError(markSourceBlobStatus(new Error('x'), undefined)), false);
		assert.equal(isBudgetedSourceBlobError(new Error('local save fault')), false);
		assert.equal(isBudgetedSourceBlobError(null), false);
	});

	it('a budgeted 503 is still classified as a hold until the budget escalates it', () => {
		const err = markSourceBlobStatus(new Error('Blob error: Blob pending replication'), 503);
		assert.equal(isUnrecoverableSourceBlobError(err), false);
		assert.equal(getBlobGapEscalation(err), undefined);
		const escalation = { cycles: 3, heldMs: 42 };
		assert.equal(markSourceBlobUnavailable(err, escalation), err);
		assert.equal(isUnrecoverableSourceBlobError(err), true);
		assert.deepEqual(getBlobGapEscalation(err), escalation);
	});

	it('a plain permanent classification carries no escalation', () => {
		assert.equal(getBlobGapEscalation(markSourceBlobUnavailable(new Error('ENOENT'))), undefined);
		assert.equal(getBlobGapEscalation(null), undefined);
		assert.equal(getBlobGapEscalation('text'), undefined);
	});
});
