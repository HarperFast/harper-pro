/**
 * Coverage for routeEntriesIncludePeer — the pure peer+database matcher behind the controlled-flow
 * direction gates (replication/knownNodes.ts, harper-pro#498).
 *
 * Both the receive gate (shouldReplicateFromNode, on `receivesFrom`) and the send gates
 * (replicationConnection send-authorization + send-side excludeTables, on `sendsTo`) ask the same
 * question: does this sendsTo/receivesFrom entry list authorize the given (peer, database) edge?
 * Its matching MUST mirror getExcludedTablesForRouteEntries so authorization and table-exclusion
 * agree on what an entry covers (target/source absent = any peer, database absent = any database).
 */
import { expect } from 'chai';
import { routeEntriesIncludePeer } from '#src/replication/knownNodes';

describe('routeEntriesIncludePeer', () => {
	const PEER = 'core';
	const DB = 'data';

	it('returns false for undefined/empty entries (no directional authorization)', () => {
		expect(routeEntriesIncludePeer(undefined, PEER, DB)).to.equal(false);
		expect(routeEntriesIncludePeer([], PEER, DB)).to.equal(false);
	});

	it('tolerates malformed input (non-array, or null/undefined elements) without throwing', () => {
		expect(routeEntriesIncludePeer({ not: 'an array' }, PEER, DB)).to.equal(false);
		expect(routeEntriesIncludePeer([null, undefined], PEER, DB)).to.equal(false);
		// a valid entry after a null element is still matched
		expect(routeEntriesIncludePeer([null, { target: 'core' }], PEER, DB)).to.equal(true);
	});

	it('matches a bare string entry naming the peer', () => {
		expect(routeEntriesIncludePeer(['core'], PEER, DB)).to.equal(true);
		expect(routeEntriesIncludePeer(['edge'], PEER, DB)).to.equal(false);
	});

	it('matches an object entry by target', () => {
		expect(routeEntriesIncludePeer([{ target: 'core' }], PEER, DB)).to.equal(true);
		expect(routeEntriesIncludePeer([{ target: 'edge' }], PEER, DB)).to.equal(false);
	});

	it('matches an object entry by source (receivesFrom shape)', () => {
		expect(routeEntriesIncludePeer([{ source: 'core' }], PEER, DB)).to.equal(true);
		expect(routeEntriesIncludePeer([{ source: 'edge' }], PEER, DB)).to.equal(false);
	});

	it('treats a missing target/source as "any peer"', () => {
		expect(routeEntriesIncludePeer([{ database: 'data' }], PEER, DB)).to.equal(true);
		expect(routeEntriesIncludePeer([{ excludeTables: ['x'] }], 'whatever', DB)).to.equal(true);
	});

	it('scopes by database when the entry specifies one', () => {
		expect(routeEntriesIncludePeer([{ target: 'core', database: 'data' }], PEER, DB)).to.equal(true);
		expect(routeEntriesIncludePeer([{ target: 'core', database: 'other' }], PEER, DB)).to.equal(false);
		// database absent on the entry => any database
		expect(routeEntriesIncludePeer([{ target: 'core' }], PEER, 'somethingElse')).to.equal(true);
	});

	it('matches if ANY entry in the list authorizes the edge', () => {
		const entries = [{ target: 'edge', database: 'data' }, 'someoneElse', { source: 'core', database: 'data' }];
		expect(routeEntriesIncludePeer(entries, PEER, DB)).to.equal(true);
	});

	it('does not match when every entry is for a different peer/database', () => {
		const entries = [{ target: 'edge' }, 'sibling', { source: 'core', database: 'other' }];
		expect(routeEntriesIncludePeer(entries, PEER, DB)).to.equal(false);
	});
});
