/**
 * Coverage for `qualifiesForMultiHopExclusion`, the ADVERTISED-intent half of the multi-hop dedup
 * exclusion decision. The full decision is owned by subscriptionManager.computeExclusionOrigins,
 * which ANDs this predicate with the effective local receive decision (shouldReplicateFromNode)
 * and the local receivesFrom coverage; workers only apply the resulting set.
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
		// A subscription-driven direct path carries ONLY the listed tables (replicateByDefault flips
		// off when node.subscriptions is present), so no subscription row shape proves full-database
		// direct delivery, and none may justify excluding the origin's whole log from a relay.
		it('never qualifies a subscription row, whatever its shape', () => {
			expect(qualifiesForMultiHopExclusion({ subscriptions: [{ database: DB, subscribe: true }] }, PEER, DB)).to.equal(
				false
			);
			expect(qualifiesForMultiHopExclusion({ subscriptions: [{ schema: DB, subscribe: true }] }, PEER, DB)).to.equal(
				false
			);
			expect(
				qualifiesForMultiHopExclusion(
					{ subscriptions: [{ database: DB, table: 'only-this-table', subscribe: true }] },
					PEER,
					DB
				)
			).to.equal(false);
			expect(qualifiesForMultiHopExclusion({ subscriptions: [{ database: DB, subscribe: false }] }, PEER, DB)).to.equal(
				false
			);
			expect(qualifiesForMultiHopExclusion({ subscriptions: [{ database: DB }] }, PEER, DB)).to.equal(false);
			expect(
				qualifiesForMultiHopExclusion({ replicates: false, subscriptions: [{ database: DB }] }, PEER, DB)
			).to.equal(false);
		});
	});

	/**
	 * Authorization is not coverage. A `sendsTo` entry authorizes a database; the sender then
	 * derives `sendExcludedTables` from that same `sendsTo` array — independently of `sends` — and
	 * skips matching records unconditionally. So an origin whose matching entry carries exclusions
	 * does NOT deliver its full log to us, and excluding it would drop those tables from the relay
	 * path too: they would arrive by neither route. Keep relay delivery when coverage is partial.
	 */
	describe('table coverage on the delivering entry', () => {
		it('does not qualify a sendsTo entry that excludes tables', () => {
			const node = { replicates: { sendsTo: [{ target: PEER, database: DB, excludeTables: ['T'] }] } };
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(false);
		});
		it('does not qualify a broadcast entry that excludes tables', () => {
			const node = { replicates: { sendsTo: [{ database: DB, excludeTables: ['T'] }] } };
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(false);
		});
		it('a blanket sends does NOT cancel a separate entry filter', () => {
			// The sender computes sendExcludedTables from sendsTo whether or not `sends` is set, so a
			// blanket flag cannot be read as full coverage when an entry narrows this peer+database.
			const node = { replicates: { sends: true, sendsTo: [{ target: PEER, database: DB, excludeTables: ['T'] }] } };
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(false);
		});
		it('a blanket sends with no entries is full coverage', () => {
			expect(qualifiesForMultiHopExclusion({ replicates: { sends: true } }, PEER, DB)).to.equal(true);
		});
		it('still qualifies when a matching entry carries no exclusions', () => {
			const node = {
				replicates: {
					sendsTo: [
						{ target: 'other-node', database: DB, excludeTables: ['T'] },
						{ target: PEER, database: DB },
					],
				},
			};
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(true);
		});
		it('ignores exclusions scoped to another database', () => {
			const node = {
				replicates: {
					sendsTo: [
						{ target: PEER, database: 'redirects', excludeTables: ['T'] },
						{ target: PEER, database: DB },
					],
				},
			};
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(true);
		});
		it('unions exclusions across every matching entry', () => {
			const node = {
				replicates: {
					sendsTo: [
						{ target: PEER, database: DB },
						{ target: PEER, database: DB, excludeTables: ['T'] },
					],
				},
			};
			expect(qualifiesForMultiHopExclusion(node, PEER, DB)).to.equal(false);
		});
		it('tolerates a non-array sendsTo, matching routeEntriesIncludePeer', () => {
			// Routes come from unvalidated YAML and rows from peers; a non-array must read as "no
			// entries" in both helpers, not throw on the subscribe/failover path.
			expect(
				qualifiesForMultiHopExclusion({ replicates: { sends: true, sendsTo: { target: PEER } } }, PEER, DB)
			).to.equal(true);
			expect(qualifiesForMultiHopExclusion({ replicates: { sendsTo: 'not-an-array' } }, PEER, DB)).to.equal(false);
		});
		it('does not throw on a null element beside a matching entry', () => {
			// routeEntriesIncludePeer tolerates a malformed element and keeps going; the exclusion
			// lookup must too, or consulting both on one array throws where the auth gate accepted it.
			expect(qualifiesForMultiHopExclusion({ replicates: { sendsTo: [PEER, null] } }, PEER, DB)).to.equal(true);
			expect(
				qualifiesForMultiHopExclusion({ replicates: { sendsTo: [{ target: PEER, database: DB }, null] } }, PEER, DB)
			).to.equal(true);
			expect(
				qualifiesForMultiHopExclusion(
					{ replicates: { sendsTo: [null, { target: PEER, database: DB, excludeTables: ['T'] }] } },
					PEER,
					DB
				)
			).to.equal(false);
		});
	});
});
