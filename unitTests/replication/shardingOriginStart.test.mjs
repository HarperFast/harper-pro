import assert from 'node:assert';
import { table } from '#src/core/resources/databases';
import { initializeResidencySlots } from '#src/core/resources/residencyMaps';
import { raiseAuditFloor, getAuditFloor } from '#src/core/resources/auditStore';
import * as env from '#src/core/utility/environment/environmentManager';
import { shardingLayout, shardingSourceAgreement, certifyShardingCopy } from '#src/replication/shardingRecovery';
import { inheritShardingHistory } from '#src/replication/shardingBootstrapState';
import { shardingInitialFloor, canResumeShardingHistory } from '#src/replication/shardingBootstrap';

describe('Sharding origin start authority', () => {
	const database = 'shardingOriginStart';
	let Rows, priorShard, floor, agreement;
	before(async () => {
		priorShard = env.get('replication_shard');
		env.setProperty('replication_shard', 0);
		await initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
		Rows = table({
			database,
			table: 'Rows',
			audit: true,
			residency: { slots: 2 },
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		floor = Math.max(Date.now(), getAuditFloor(Rows.auditStore)) + 1;
		agreement = shardingSourceAgreement(database);
		inheritShardingHistory(Rows.dbisDB, shardingLayout(database), {
			phase: 'active',
			initializer: 'founder',
			run: 'initial',
			agreement: 'initial-members',
			floors: { founder: floor },
		});
	});
	after(() => env.setProperty('replication_shard', priorShard));
	it('cannot use a starting floor before obtaining a complete owned baseline', async () => {
		assert.equal(shardingInitialFloor(database, 'founder'), undefined);
		assert.equal(shardingInitialFloor(database, 'late', 'late', { 0: { agreement, floor } }), undefined);
		await certifyShardingCopy(database, shardingLayout(database));
		assert.equal(shardingInitialFloor(database, 'founder'), floor);
	});
	it('admits a late origin only from its own authenticated setup under the current policy', () => {
		const starts = { 0: { agreement, floor: floor + 10 } };
		assert.equal(shardingInitialFloor(database, 'late', 'late', starts), floor + 10);
		assert.equal(shardingInitialFloor(database, 'late', 'relay', starts), undefined);
		assert.equal(shardingInitialFloor(database, 'late', undefined, starts), undefined);
		assert.equal(shardingInitialFloor(database, 'late', 'late', { 1: starts[0] }), undefined);
		assert.equal(
			shardingInitialFloor(database, 'late', 'late', { 0: { agreement: 'other-policy', floor } }),
			undefined
		);
		for (const value of [0, -1, NaN, Infinity, '123'])
			assert.equal(shardingInitialFloor(database, 'late', 'late', { 0: { agreement, floor: value } }), undefined);
	});
	it('never skips an earlier proven start after a later direct announcement', () => {
		assert.equal(shardingInitialFloor(database, 'founder', 'founder', { 0: { agreement, floor: floor + 10 } }), floor);
		assert.equal(
			shardingInitialFloor(database, 'founder', 'founder', { 0: { agreement, floor: floor - 1 } }),
			floor - 1
		);
	});
	it('refuses a starting floor whose history has fallen outside retention', () => {
		assert.equal(canResumeShardingHistory(database, 0, floor), true);
		raiseAuditFloor(Rows.auditStore, floor + 10);
		assert.equal(canResumeShardingHistory(database, 0, floor), false);
	});
});
