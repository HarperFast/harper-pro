/**
 * Coverage for `qualifiesForMultiHopExclusion` — the predicate behind the `SUBSCRIPTION_UPDATE
 * excludeNodes` multi-hop dedup exclusion (both the initial excluded-list build and the dynamic
 * hdb_nodes-event updater in replicationConnection.ts).
 *
 * Background: the qualifier previously tested only `replicates === true || replicates?.sends`, so
 * a directional peer (`{ sendsTo: [...] }`, no `.sends` — every config-route peer and add_node
 * directional peer) was never excluded from relay. Every subscriber then received that origin's
 * writes once per mesh member; applies dedupe, but each redundant delivery persisted a
 * same-version audit entry (concurrent-delivery dedup race, tracked separately) and restart
 * replay became O(peers^2) — observed wedging a production 16-node mesh's data database at
 * 350 writes/sec through a one-way bridge route.
 *
 * The data-loss direction is the other way (#370/#399 family): excluding an origin whose row does
 * NOT prove direct delivery to this subscriber for this database silently drops its records. So
 * these tests pin both sides: directional rows that target the subscriber+database qualify, and
 * rows that target another peer, another database, or only declare `receivesFrom` never do.
 */

import { expect } from 'chai';
import { qualifiesForMultiHopExclusion } from '#src/replication/knownNodes';

const PEER = 'sub-node-a';
const DB = 'data';

describe('qualifiesForMultiHopExclusion', () => {
	describe('full and blanket-directional replication', () => {
		it('qualifies replicates === true', () => {
			expect(qualifiesForMultiHopExclusion({ replicates: true }, PEER, DB)).to.equal(true);
		});
		it('qualifies a blanket directional sends', () => {
			expect(qualifiesForMultiHopExclusion({ replicates: { sends: true } }, PEER, DB)).to.equal(true);
		});
		it('does not qualify replicates false or absent', () => {
			expect(qualifiesForMultiHopExclusion({ replicates: false }, PEER, DB)).to.equal(false);
			expect(qualifiesForMultiHopExclusion({}, PEER, DB)).to.equal(false);
			expect(qualifiesForMultiHopExclusion(undefined, PEER, DB)).to.equal(false);
		});
	});

	describe('directional sendsTo rows', () => {
		it('qualifies a string entry naming the subscriber', () => {
			expect(qualifiesForMultiHopExclusion({ replicates: { sendsTo: [PEER] } }, PEER, DB)).to.equal(true);
		});
		it('qualifies an object entry matching subscriber and database', () => {
			const node = { replicates: { sendsTo: [{ target: PEER, database: DB }] } };
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(true);
		});
		it('qualifies a wildcard-database entry for the subscriber', () => {
			const node = { replicates: { sendsTo: [{ target: PEER }] } };
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(true);
		});
		it('qualifies a broadcast entry with no target for the matching database', () => {
			const node = { replicates: { sendsTo: [{ database: DB }] } };
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(true);
		});
		it('does not qualify an entry targeting a different peer', () => {
			const node = { replicates: { sendsTo: [{ target: 'other-node', database: DB }] } };
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(false);
		});
		it('does not qualify an entry scoped to a different database', () => {
			const node = { replicates: { sendsTo: [{ target: PEER, database: 'redirects' }] } };
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(false);
		});
		it('does not qualify a receives-only directional row', () => {
			const node = { replicates: { receives: true, receivesFrom: [{ source: 'origin-x' }] } };
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(false);
		});
		it('skips null and undefined entries', () => {
			const node = { replicates: { sendsTo: [null, undefined] } };
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(false);
		});
		it('treats a truthy non-string entry with no fields as a wildcard, mirroring the auth gates', () => {
			// Inherited from routeEntriesIncludePeer: authorization and exclusion must agree on what
			// an entry covers, and there `target`/`source`/`database` absent all mean "any".
			const node = { replicates: { sendsTo: [42] } };
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(true);
		});
		it('qualifies the one-way bridge row shape for a listed target only', () => {
			const node = {
				replicates: {
					sendsTo: [{ target: PEER }, { target: 'sub-node-b' }],
					receivesFrom: [{ source: 'v4-source' }],
				},
			};
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(true);
			expect(qualifiesForMultiHopExclusion(node, 'stranger-node', DB)).to.equal(false);
		});
	});

	describe('subscription rows', () => {
		it('qualifies a subscription for the database', () => {
			const node = { subscriptions: [{ database: DB }] };
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(true);
		});
		it('honors the legacy schema field', () => {
			const node = { subscriptions: [{ schema: DB }] };
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(true);
		});
		it('does not qualify subscribe: false or another database', () => {
			expect(qualifiesForMultiHopExclusion({ subscriptions: [{ database: DB, subscribe: false }] }, PEER, DB)).to.equal(
				false
			);
			expect(qualifiesForMultiHopExclusion({ subscriptions: [{ database: 'redirects' }] }, PEER, DB)).to.equal(false);
		});
	});
});
