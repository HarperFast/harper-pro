import assert from 'node:assert/strict';
import {
	isExplicitDatabaseSubscription,
	isReplicatedDatabase,
	tableReplicates,
} from '#src/replication/replicatedDatabases';

describe('isReplicatedDatabase', () => {
	it('accepts everything when replication.databases is unset or a wildcard', () => {
		assert.equal(isReplicatedDatabase(undefined, 'data'), true);
		assert.equal(isReplicatedDatabase('*', 'data'), true);
	});

	it('matches string entries by name', () => {
		assert.equal(isReplicatedDatabase(['data'], 'data'), true);
		assert.equal(isReplicatedDatabase(['data'], 'other'), false);
	});

	it('excludes the system database when replication.databases lists only user databases', () => {
		// `shouldReplicateFromNode` runs every database through this filter, system included, so a
		// node configured with `databases: ['data']` never opens a system replication socket. The
		// clone's sync monitor must not require that socket, or it waits Unavailable forever.
		assert.equal(isReplicatedDatabase(['data'], 'system'), false);
		assert.equal(isReplicatedDatabase(undefined, 'system'), true);
		assert.equal(isReplicatedDatabase('*', 'system'), true);
	});

	it('lets callers select the safe fallback for malformed non-array configuration', () => {
		assert.equal(isReplicatedDatabase('data', 'data'), true);
		assert.equal(isReplicatedDatabase('data', 'data', undefined, false), false);
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

describe('tableReplicates', () => {
	it('treats only an explicit replicate: false as non-replicating', () => {
		assert.equal(tableReplicates({ replicate: false }), false);
		assert.equal(tableReplicates({ replicate: true }), true);
		assert.equal(tableReplicates({}), true);
	});

	it('reads a describe_all entry and a live Table alike', () => {
		assert.equal(tableReplicates({ name: 'LocalKeyspace', replicate: false, attributes: [] }), false);
		assert.equal(
			tableReplicates(
				class Table {
					static replicate = false;
				}
			),
			false
		);
	});

	it('is true for an absent table, so an unknown name is not itself an exclusion', () => {
		assert.equal(tableReplicates(undefined), true);
	});
});
