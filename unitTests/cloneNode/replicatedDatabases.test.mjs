import assert from 'node:assert/strict';
import { isExplicitDatabaseSubscription, isReplicatedDatabase } from '#src/replication/replicatedDatabases';

describe('isReplicatedDatabase', () => {
	it('accepts everything when replication.databases is unset or a wildcard', () => {
		assert.equal(isReplicatedDatabase(undefined, 'data'), true);
		assert.equal(isReplicatedDatabase('*', 'data'), true);
	});

	it('matches string entries by name', () => {
		assert.equal(isReplicatedDatabase(['data'], 'data'), true);
		assert.equal(isReplicatedDatabase(['data'], 'other'), false);
	});

	it('matches unsharded object entries by name regardless of the shard predicate', () => {
		assert.equal(
			isReplicatedDatabase([{ name: 'data' }], 'data', () => false),
			true
		);
	});

	it('accepts a sharded entry only when the shard predicate does (same-shard leader)', () => {
		const entries = [{ name: 'data', sharded: true }];
		assert.equal(
			isReplicatedDatabase(entries, 'data', () => true),
			true
		);
		assert.equal(
			isReplicatedDatabase(entries, 'data', () => false),
			false
		);
	});

	it('fails closed for a sharded entry when no shard predicate is supplied', () => {
		// Callers that cannot evaluate the leader's shard must keep the database as a sync target:
		// a wrong inclusion stalls the clone visibly, a wrong exclusion skips verifying a copy.
		assert.equal(isReplicatedDatabase([{ name: 'data', sharded: true }], 'data'), true);
	});

	it('includes explicit subscriptions using the same predicate as node replication', () => {
		assert.equal(isExplicitDatabaseSubscription([{ database: 'data', subscribe: true }], 'data'), true);
		assert.equal(isExplicitDatabaseSubscription([{ schema: 'data', subscribe: false }], 'data'), false);
		assert.equal(isExplicitDatabaseSubscription([null, 'data'], 'data'), false);
	});
});
