import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimatedHours, fabricPolicy, pinnedPolicy, planProfile, unconstrainedPolicy } from './matrix.mts';

const GiB = 1024 ** 3;

describe('memory policies', () => {
	it('mirrors host-manager for the 6 GB starting instance', () => {
		const policy = fabricPolicy('100%', 1, 6 * GiB);
		assert.equal(policy.memoryMaxBytes, 6 * GiB);
		assert.equal(policy.memoryHighBytes, 5 * GiB);
		assert.equal(policy.blockCacheBytes, Math.floor(6 * GiB * 0.15));
		assert.equal(policy.writeBufferManagerBytes, Math.floor(6 * GiB * 0.05));
	});

	it('pins only the block cache in the control cell', () => {
		const pinned = pinnedPolicy(0.5, 6 * GiB);
		const plain = fabricPolicy('50%', 0.5, 6 * GiB);
		assert.equal(pinned.memoryMaxBytes, 3 * GiB);
		assert.equal(pinned.memoryHighBytes, plain.memoryHighBytes);
		assert.equal(pinned.writeBufferManagerBytes, plain.writeBufferManagerBytes);
		assert.equal(pinned.blockCacheBytes, fabricPolicy('100%', 1, 6 * GiB).blockCacheBytes);
	});

	it('lifts the cgroup limits but keeps the instance configuration when unconstrained', () => {
		const policy = unconstrainedPolicy(6 * GiB);
		assert.equal(policy.memoryMaxBytes, null);
		assert.equal(policy.memoryHighBytes, null);
		assert.equal(policy.blockCacheBytes, fabricPolicy('100%', 1, 6 * GiB).blockCacheBytes);
	});

	it('rounds step limits to whole MiB', () => {
		assert.equal(fabricPolicy('70%', 0.7, 6 * GiB).memoryMaxBytes! % (1024 * 1024), 0);
	});
});

describe('planProfile', () => {
	it('builds the full task matrix within the VM lifetime', () => {
		const plans = planProfile('full');
		assert.deepEqual(
			plans.map((plan) => [plan.name, plan.cells.length, plan.calibrations.length]),
			[
				['d1x-1k', 50, 8],
				['d2x-1k', 50, 8],
				['d4x-1k', 50, 8],
				['d2x-4k', 10, 2],
			]
		);
		for (const plan of plans) {
			assert.equal(
				new Set(plan.cells.map((cell) => cell.id)).size,
				plan.cells.length,
				`${plan.name} has duplicate cell ids`
			);
			assert.ok(estimatedHours(plan) < 40, `${plan.name}: ${estimatedHours(plan)} h`);
		}
		const d4 = plans.find((plan) => plan.name === 'd4x-1k')!;
		assert.ok(d4.records > 22_000_000 && d4.records < 26_000_000, `${d4.records}`);
		assert.equal(d4.keyWidth, String(d4.records - 1).length);
	});

	it('selects pairs by name and rejects unknown ones', () => {
		assert.deepEqual(
			planProfile('full', ['d2x-4k']).map((plan) => plan.name),
			['d2x-4k']
		);
		assert.throws(() => planProfile('full', ['nope']), /unknown pair/);
		assert.throws(() => planProfile('nope'), /unknown profile/);
	});

	it('keeps the smoke profile small', () => {
		const [smoke] = planProfile('smoke');
		assert.equal(smoke.cells.length, 6);
		assert.ok(estimatedHours(smoke) < 1.2);
	});
});
