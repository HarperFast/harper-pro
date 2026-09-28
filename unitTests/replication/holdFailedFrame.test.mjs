import { expect } from 'chai';
import { holdFailedFrame } from '#src/replication/replicationConnection';

describe('holdFailedFrame', () => {
	it('replays a failed frame up to the limit, then moves past it', () => {
		const attempts = new Map();
		const decisions = [1, 2, 3, 4].map(() => holdFailedFrame(attempts, 'peer/db', 100, 2));
		expect(decisions).to.deep.equal([true, true, false, false]);
	});

	it('starts counting again at a new position and per peer', () => {
		const attempts = new Map();
		holdFailedFrame(attempts, 'peer/db', 100, 1);
		expect(holdFailedFrame(attempts, 'peer/db', 100, 1)).to.equal(false);
		expect(holdFailedFrame(attempts, 'peer/db', 200, 1)).to.equal(true);
		expect(holdFailedFrame(attempts, 'other/db', 100, 1)).to.equal(true);
	});
});
