/**
 * Coverage for the cross-reconnect blob-gap escalation budget (harper-pro#432).
 *
 * Background: a source-reported 503 (PENDING placeholder / read timeout at the origin) holds the
 * receiver's resume cursor (`hasBlobGap`) until the #683 timer reconnects; the re-stream reproduces the
 * 503 and every per-socket counter restarts with the socket, so a source that answers 503 forever pinned
 * the cursor forever. `createBlobGapEscalationBudget` lives on the persistent NodeReplicationConnection
 * and charges one cycle per socket generation per held delivery; an exhausted delivery is reclassified
 * as unrecoverable (`markSourceBlobUnavailable`) so the existing advance-past branch skips it.
 *
 * These tests pin the contract the production wiring depends on: one charge per generation, the cycle
 * and wall-clock bounds, resolve-resets, per-delivery independence, stickiness after exhaustion (the
 * leapfrog guard), stale-generation inertness, and the non-evicting overflow policy.
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
		assert.deepEqual(budget.charge(A, 3), { cycles: 3, heldMs: 0, overflow: false });
	});

	it('trips on the cycle bound after maxCycles distinct generations', () => {
		const budget = createBlobGapEscalationBudget({ maxCycles: 2, maxHoldMs: 0, now: fakeClock().now });
		assert.equal(budget.charge(A, 1), undefined);
		const escalation = budget.charge(A, 2);
		assert.equal(escalation.cycles, 2);
		assert.equal(escalation.overflow, false);
	});

	it('trips on the wall-clock bound first when the hold outlives maxHoldMs', () => {
		const clock = fakeClock(5_000);
		const budget = createBlobGapEscalationBudget({ maxCycles: 10, maxHoldMs: 1_000, now: clock.now });
		assert.equal(budget.charge(A, 1), undefined);
		clock.tick(999);
		assert.equal(budget.charge(A, 2), undefined);
		clock.tick(1);
		assert.deepEqual(budget.charge(A, 3), { cycles: 3, heldMs: 1_000, overflow: false });
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

	it('never evicts live progress: at capacity a new delivery escalates as overflow and is not tracked', () => {
		const budget = createBlobGapEscalationBudget({ maxCycles: 3, maxHoldMs: 0, maxTracked: 2, now: fakeClock().now });
		budget.charge(A, 1);
		budget.charge(B, 1);
		const C = blobGapDeliveryKey('c3', 3);
		assert.deepEqual(budget.charge(C, 1), { cycles: 0, heldMs: 0, overflow: true });
		assert.equal(budget.size, 2);
		assert.equal(budget.charge(A, 2), undefined); // tracked deliveries keep their own budget
		assert.equal(budget.charge(A, 3).cycles, 3);
		budget.resolve(A, 3);
		assert.equal(budget.charge(C, 3), undefined); // room again: tracked from here
		assert.equal(budget.size, 2);
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
		assert.equal(blobGapDeliveryKey('f1', 'k'), 'f1|k');
	});
});

describe('describeBlobGapEscalation', () => {
	const limits = { maxCycles: 10, maxHoldMs: 1_800_000, maxTracked: 10_000 };

	it('names the exhausted budget, its spend, and its limits', () => {
		const text = describeBlobGapEscalation({ cycles: 3, heldMs: 6_500.4, overflow: false }, limits);
		assert.ok(
			text.includes('blob-gap escalation budget exhausted after 3 reconnect cycle(s) holding it for 6500ms'),
			text
		);
		assert.ok(text.includes('10 cycles / 1800000 ms'), text);
	});

	it('reports a disabled bound as "no"', () => {
		const text = describeBlobGapEscalation({ cycles: 2, heldMs: 0, overflow: false }, { ...limits, maxHoldMs: 0 });
		assert.ok(text.includes('10 cycles / no ms'), text);
	});

	it('names the overflow policy distinctly', () => {
		const text = describeBlobGapEscalation({ cycles: 0, heldMs: 0, overflow: true }, limits);
		assert.ok(text.includes('blob-gap escalation budget overflow'), text);
		assert.ok(text.includes('10000 held deliveries'), text);
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
		const escalation = { cycles: 3, heldMs: 42, overflow: false };
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
