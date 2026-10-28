import assert from 'node:assert';
import {
	SHARDING_CERTIFICATE_PRINCIPAL,
	receiveShardingBootstrap,
	setShardingBootstrapHandler,
} from '#src/replication/shardingBootstrapRpc';

describe('Private sharding bootstrap authority', () => {
	afterEach(() => setShardingBootstrapHandler(undefined));
	it('refuses credentials, IP-authorized nodes and a certificate claiming another member', async () => {
		let calls = 0;
		setShardingBootstrapHandler(async () => {
			calls++;
			return {};
		});
		for (const principal of [
			undefined,
			{ username: 'admin', role: { permission: { super_user: true } } },
			{ name: 'node-a', replicates: true },
			{ name: 'node-a', [SHARDING_CERTIFICATE_PRINCIPAL]: 'node-b' },
			{ name: 'node-b', [SHARDING_CERTIFICATE_PRINCIPAL]: 'node-b' },
		])
			await assert.rejects(receiveShardingBootstrap({ from: 'node-a' }, principal), /authenticated node certificate/);
		assert.equal(calls, 0);
	});
	it('binds the handler to the exact certified member and returns its failure', async () => {
		const principal = { name: 'node-a', [SHARDING_CERTIFICATE_PRINCIPAL]: 'node-a' };
		await assert.rejects(receiveShardingBootstrap({ from: 'node-a' }, principal), /not initialized/);
		setShardingBootstrapHandler(async (request, member) => {
			assert.equal(member, 'node-a');
			assert.equal(request.action, 'floor');
			throw new Error('durability unavailable');
		});
		await assert.rejects(
			receiveShardingBootstrap({ from: 'node-a', action: 'floor' }, principal),
			/durability unavailable/
		);
	});
});
