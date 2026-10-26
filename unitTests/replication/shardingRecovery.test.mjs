import assert from 'node:assert';
import {
	admitsShardedOrigin,
	admitsShardedCopy,
	publishShardingCertificate,
	peerHasShardingCertificate,
	shardingLayout,
	shardingCertificate,
	shardingSourceAgreement,
	shardingSourceCertificate,
	shardingRecoveryScopes,
	certifyShardingCopy,
	revokeShardingCertificate,
} from '#src/replication/shardingRecovery';
import { table } from '#src/core/resources/databases';
import { initializeResidencySlots } from '#src/core/resources/residencyMaps';
import { shardingBaselineState } from '#src/core/resources/shardingCompleteness';
import * as env from '#src/core/utility/environment/environmentManager';

import {
	REPLICATION_SHARED_STATUS_SLOTS,
	CONNECTION_STATE_POSITION,
	CONNECTION_STATE_CONNECTED,
	SHARDING_CERTIFICATE_GENERATION_POSITION,
} from '#src/replication/sharedStatusSlots';

describe('Sharding complete source admission', () => {
	it('an owner accepts the origin or a certified co-owner only', () => {
		assert.equal(admitsShardedOrigin('owned', 0, 'origin', 'origin', 1, undefined), true);
		assert.equal(admitsShardedOrigin('owned', 0, 'relay', 'origin', 1, 'owned'), false);
		assert.equal(admitsShardedOrigin('owned', 0, 'relay', 'origin', 0, undefined), false);
		assert.equal(admitsShardedOrigin('owned', 0, 'relay', 'origin', 0, 'different-slots'), false);
		assert.equal(admitsShardedOrigin('owned', 0, 'relay', 'origin', 0, 'owned'), true);
	});
	it('an owner copy requires a complete co-owner even when the source is an origin', () => {
		assert.equal(admitsShardedCopy('owned', 0, 1, 'owned'), false);
		assert.equal(admitsShardedCopy('owned', 0, 0, undefined), false);
		assert.equal(admitsShardedCopy('owned', 0, 0, 'owned'), true);
	});
	it('publishes only a complete current-session ownership certificate', () => {
		const status = new Float64Array(new SharedArrayBuffer(REPLICATION_SHARED_STATUS_SLOTS * 8));
		const digest = '12345678'.repeat(8);
		status[CONNECTION_STATE_POSITION] = CONNECTION_STATE_CONNECTED;
		assert.equal(peerHasShardingCertificate(status, 0, digest), false);
		publishShardingCertificate(status, 0, digest);
		assert.equal(peerHasShardingCertificate(status, 0, digest), true);
		assert.equal(peerHasShardingCertificate(status, 1, digest), false);
		assert.equal(peerHasShardingCertificate(status, 0, '87654321'.repeat(8)), false);
		const words = new Int32Array(status.buffer);
		Atomics.add(words, SHARDING_CERTIFICATE_GENERATION_POSITION * 2, 1);
		assert.equal(
			peerHasShardingCertificate(status, 0, digest),
			false,
			'an incomplete publication is not a certificate'
		);
		Atomics.add(words, SHARDING_CERTIFICATE_GENERATION_POSITION * 2, 1);
		status[CONNECTION_STATE_POSITION] = 0;
		assert.equal(peerHasShardingCertificate(status, 0, digest), false, 'a dead worker cannot remain a relay candidate');
		status[CONNECTION_STATE_POSITION] = CONNECTION_STATE_CONNECTED;
		publishShardingCertificate(status, undefined, undefined);
		assert.equal(
			peerHasShardingCertificate(status, 0, digest),
			false,
			'the next uncertified socket clears the prior mirror'
		);
	});
	it('zero-slot receivers retain unrestricted stub streams and copies', () => {
		assert.equal(admitsShardedOrigin(undefined, undefined, 'relay', 'origin', 1, undefined), true);
		assert.equal(admitsShardedCopy(undefined, undefined, 1, undefined), true);
	});
});

describe('Native sharding completeness certificates', () => {
	let Rows, Legacy, layout, priorShard;
	const database = 'certificateScope';
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
		Legacy = table({ database, table: 'Legacy', audit: true, attributes: [{ name: 'id', isPrimaryKey: true }] });
		layout = shardingLayout(database);
	});
	after(() => env.setProperty('replication_shard', priorShard));
	it('binds recovery authority to every current table policy without changing the stored ownership layout', async () => {
		await certifyShardingCopy(database, layout);
		assert.equal(
			shardingSourceCertificate(database),
			undefined,
			'a catalog receipt alone does not publish a ready baseline'
		);
		Atomics.store(shardingBaselineState(Rows.primaryStore.rootStore, database), 0, 1);
		const token = shardingSourceCertificate(database);
		assert.equal(token, shardingSourceAgreement(database));
		table({
			database,
			table: 'Later',
			audit: true,
			residency: { slots: 2, slotFrom: '0' },
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		assert.equal(shardingLayout(database), layout);
		assert.notEqual(shardingSourceCertificate(database), token);
	});
	it('revokes admission and refuses an older copy certificate after a later legacy activation', async () => {
		const scopes = shardingRecoveryScopes(database);
		await certifyShardingCopy(database, layout, scopes);
		assert.equal(shardingCertificate(database), layout);
		const ready = shardingBaselineState(Rows.primaryStore.rootStore, database);
		Atomics.store(ready, 0, 1);
		table({
			database,
			table: 'Legacy',
			audit: true,
			residency: { slots: 2 },
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		assert.ok(Legacy.residency);
		assert.equal(
			Atomics.load(ready, 0),
			0,
			'activation must close admission before the old certificate is reconsidered'
		);
		assert.equal(shardingCertificate(database), undefined);
		await assert.rejects(certifyShardingCopy(database, layout, scopes), /roots changed/);
		assert.equal(shardingCertificate(database), undefined);
		await certifyShardingCopy(database, layout, shardingRecoveryScopes(database));
		assert.equal(shardingCertificate(database), layout);
		Atomics.store(ready, 0, 1);
		await revokeShardingCertificate(database);
		assert.equal(Atomics.load(ready, 0), 0);
		assert.equal(shardingCertificate(database), undefined);
	});
});
