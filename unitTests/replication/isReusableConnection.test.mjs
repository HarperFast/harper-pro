/**
 * A cached replication connection that was intentionally torn down (the empty-subscription delayed
 * close marks it intentionallyUnsubscribed/isFinished) must not be handed back out: connect()
 * early-returns forever on intentionallyUnsubscribed, so reusing it leaves a desired peer
 * permanently connected:false with no retry. isReusableConnection is the guard the connection
 * getters use to drop such a connection and create a fresh one instead. See harper-pro#233 / #289.
 */

import { expect } from 'chai';
import { isReusableConnection } from '#src/replication/replicator';

describe('isReusableConnection', () => {
	it('returns false for a missing connection', () => {
		expect(isReusableConnection(undefined)).to.equal(false);
		expect(isReusableConnection(null)).to.equal(false);
	});

	it('returns true for a live connection', () => {
		expect(isReusableConnection({ isFinished: false, intentionallyUnsubscribed: false })).to.equal(true);
	});

	it('returns false for an intentionally-unsubscribed connection', () => {
		expect(isReusableConnection({ isFinished: false, intentionallyUnsubscribed: true })).to.equal(false);
	});

	it('returns false for a finished connection', () => {
		expect(isReusableConnection({ isFinished: true, intentionallyUnsubscribed: false })).to.equal(false);
	});
});
