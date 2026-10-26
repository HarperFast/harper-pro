import assert from 'node:assert';
import sinon from 'sinon';
import { getIdOfRemoteNode } from '#src/core/resources/nodeIdMapping';
import { table } from '#src/core/resources/databases';
import { initializeResidencySlots } from '#src/core/resources/residencyMaps';
import { raiseAuditFloor, getAuditFloor } from '#src/core/resources/auditStore';
import * as env from '#src/core/utility/environment/environmentManager';
import { shardingLayout, shardingSourceAgreement, certifyShardingCopy } from '#src/replication/shardingRecovery';
import { inheritShardingHistory, frozenShardingOriginFloor } from '#src/replication/shardingBootstrapState';
import {
	shardingInitialFloor,
	validateShardingOriginEvidence,
	hasPriorShardingOrigin,
	noteShardingOriginStart,
	canResumeShardingHistory,
} from '#src/replication/shardingBootstrap';

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
	it('recognizes admitted names without confusing an unknown name with a prior origin', async () => {
		assert.equal(await hasPriorShardingOrigin(database, shardingLayout(database), 'founder'), true);
		assert.equal(await hasPriorShardingOrigin(database, shardingLayout(database), 'unadmitted'), false);
	});
	it('recognizes retained slot mutations but not preconversion records or metadata alone', async () => {
		const origin = 'retained-origin';
		getIdOfRemoteNode(origin, Rows.auditStore);
		const scan = sinon.stub(Rows.auditStore, 'getRange');
		try {
			for (const [entry, expected] of [
				[{ type: 'put', tableId: Rows.tableId }, false],
				[{ type: 'put', tableId: Rows.tableId, residencySlot: 0 }, true],
				[{ type: 'delete', tableId: Rows.tableId, previousResidencySlot: 0 }, true],
				[{ type: 'put', tableId: Rows.tableId + 100, residencySlot: 0 }, false],
			]) {
				scan.returns([entry]);
				assert.equal(await hasPriorShardingOrigin(database, shardingLayout(database), origin), expected);
			}
		} finally {
			scan.restore();
		}
	});
	it('cannot use a starting floor before obtaining a complete owned baseline', async () => {
		await noteShardingOriginStart(database, 'late', { 0: { agreement, floor: floor + 10 } });
		assert.equal(shardingInitialFloor(database, 'founder'), undefined);
		assert.equal(shardingInitialFloor(database, 'late'), undefined);
		await certifyShardingCopy(database, shardingLayout(database));
		assert.equal(shardingInitialFloor(database, 'founder'), floor);
		assert.equal(shardingInitialFloor(database, 'late'), floor + 10);
		assert.equal(await hasPriorShardingOrigin(database, shardingLayout(database), 'late'), true);
	});
	it('accepts only the authenticated peer’s own start under the current policy', async () => {
		await noteShardingOriginStart(database, 'relay', { 0: { agreement, floor: floor + 10 } });
		assert.equal(shardingInitialFloor(database, 'unknown'), undefined);
		for (const starts of [
			{ 1: { agreement, floor } },
			{ 0: { agreement: 'other-policy', floor } },
			...[0, -1, NaN, Infinity, '123'].map((value) => ({ 0: { agreement, floor: value } })),
		]) {
			await noteShardingOriginStart(database, 'unknown', starts);
			assert.equal(shardingInitialFloor(database, 'unknown'), undefined);
		}
	});
	it('never skips an earlier proven start after a later direct announcement', async () => {
		await noteShardingOriginStart(database, 'founder', { 0: { agreement, floor: floor + 10 } });
		assert.equal(shardingInitialFloor(database, 'founder'), floor);
		await noteShardingOriginStart(database, 'founder', { 0: { agreement, floor: floor - 1 } });
		assert.equal(shardingInitialFloor(database, 'founder'), floor - 1);
	});
	it('retains the minimum after reconnects and later announcements', async () => {
		assert.equal(shardingInitialFloor(database, 'late'), floor + 10);
		await noteShardingOriginStart(database, 'late', { 0: { agreement, floor: floor + 20 } });
		assert.equal(shardingInitialFloor(database, 'late'), floor + 10);
		await noteShardingOriginStart(database, 'late', { 0: { agreement, floor: floor + 5 } });
		assert.equal(shardingInitialFloor(database, 'late'), floor + 5);
		await noteShardingOriginStart(database, 'relay', { 0: { agreement, floor: floor - 20 } });
		assert.equal(shardingInitialFloor(database, 'late'), floor + 5);
	});
	it('refuses a starting floor whose history has fallen outside retention', () => {
		assert.equal(canResumeShardingHistory(database, 0, floor), true);
		raiseAuditFloor(Rows.auditStore, floor + 10);
		assert.equal(canResumeShardingHistory(database, 0, floor), false);
	});
});

describe('Reused sharding origin admission evidence', () => {
	it('refuses prior admission even when another member has not answered', () => {
		assert.throws(
			() => validateShardingOriginEvidence([{ priorOrigin: true, bound: 100 }, {}], 'old-name'),
			/complete backup.*new node name/
		);
	});
	it('requires an explicit negative from every peer rather than accepting old response formats', () => {
		for (const answer of [{ bound: 100 }, { priorOrigin: null, bound: 100 }, { priorOrigin: false }])
			assert.throws(() => validateShardingOriginEvidence([answer], 'new-name'), /evidence from every member/);
	});
	it('uses metadata maxima only as issuance bounds for an origin never admitted before', () => {
		assert.equal(
			validateShardingOriginEvidence(
				[
					{ priorOrigin: false, bound: 100 },
					{ priorOrigin: false, bound: 200 },
				],
				'new-name'
			),
			200
		);
	});
	it('binds a frozen origin start to the node name that established it', () => {
		const state = { phase: 'active', run: 'r', initializer: 'a', agreement: 'm', localFloor: 100, localOrigin: 'a' };
		assert.equal(frozenShardingOriginFloor(state, 'a'), 100);
		assert.equal(frozenShardingOriginFloor(state, 'b'), undefined);
	});
});
