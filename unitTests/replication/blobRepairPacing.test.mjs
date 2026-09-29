import assert from 'node:assert';
import { createRepairPacing } from '#src/replication/blobRepair';

describe('blob repair pacing', () => {
	it('starts its failure-run budget at the first unrepairable record', () => {
		let now = 0;
		const pacing = createRepairPacing({ now: () => now, random: () => 0.5 });

		now = 65_000;
		assert.notEqual(pacing.nextDelay(), undefined);
		now += 60_000;
		assert.equal(pacing.nextDelay(), undefined);

		pacing.reset();
		assert.notEqual(pacing.nextDelay(), undefined);
	});
});
