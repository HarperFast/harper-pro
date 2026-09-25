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

	it('returns the end function synchronously when no frame holds the turn', () => {
		const subscription = {};
		const endTurn = takeFrameTurn(subscription);
		expect(endTurn).to.be.a('function');
		endTurn();
		expect(takeFrameTurn(subscription)).to.be.a('function');
	});

	it('does not order frames of different subscriptions', () => {
		takeFrameTurn({}); // never ended
		expect(takeFrameTurn({})).to.be.a('function');
	});
});
