import { expect } from 'chai';
import { takeFrameTurn } from '#src/replication/replicationConnection';

const settle = () => new Promise(setImmediate);

describe('takeFrameTurn', () => {
	it('starts a frame on a subscription only after the earlier frame ends its turn', async () => {
		const subscription = {};
		const order = [];
		const endFirst = await takeFrameTurn(subscription);
		const second = takeFrameTurn(subscription).then((endTurn) => {
			order.push('second');
			return endTurn;
		});
		const third = takeFrameTurn(subscription).then((endTurn) => {
			order.push('third');
			return endTurn;
		});
		await settle();
		expect(order).to.deep.equal([]);
		endFirst();
		const endSecond = await second;
		await settle();
		expect(order).to.deep.equal(['second']);
		endSecond();
		(await third)();
		expect(order).to.deep.equal(['second', 'third']);
	});

	it('does not order frames of different subscriptions', async () => {
		await takeFrameTurn({}); // never ended
		let started = false;
		takeFrameTurn({}).then(() => (started = true));
		await settle();
		expect(started).to.equal(true);
	});
});
