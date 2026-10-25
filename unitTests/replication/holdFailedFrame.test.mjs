import { expect } from 'chai';
import { ResidencyConfigurationError } from '#src/core/resources/residencyMaps';
import { holdFailedFrame } from '#src/replication/replicationConnection';

describe('holdFailedFrame', () => {
	it('replays a failed frame up to the limit, then moves past it', () => {
		const attempts = new Map();
		const decisions = [1, 2, 3, 4].map(() => holdFailedFrame(attempts, 'peer/db', 100, 2));
		expect(decisions).to.deep.equal([true, true, false, false]);
	});

	it('holds placement refusals beyond the poison-frame limit without consuming that budget', () => {
		const attempts = new Map();
		const error = new ResidencyConfigurationError('placement temporarily unavailable', 503);
		for (let n = 0; n < 8; n++) expect(holdFailedFrame(attempts, 'peer/db', 100, 2, error)).to.equal(true);
		expect(attempts.size).to.equal(0);
		expect(holdFailedFrame(attempts, 'peer/db', 100, 2, new Error('bad record'))).to.equal(true);
	});

	it('starts counting again at a new position and per peer', () => {
		const attempts = new Map();
		holdFailedFrame(attempts, 'peer/db', 100, 1);
		expect(holdFailedFrame(attempts, 'peer/db', 100, 1)).to.equal(false);
		expect(holdFailedFrame(attempts, 'peer/db', 200, 1)).to.equal(true);
		expect(holdFailedFrame(attempts, 'other/db', 100, 1)).to.equal(true);
	});
});
