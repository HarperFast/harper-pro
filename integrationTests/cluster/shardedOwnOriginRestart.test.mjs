// A sharded node restarted on the same boot continues an own-origin recovery epoch its cross-shard peers never
// finish. Asking its same-shard co-owner for its own writes back would bring its sharded records outside a
// snapshot copy, which the decoder refuses by closing the link, on every reconnect (harper-pro#1364).
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { restartNode, stopAndTeardownNodes } from './clusterShared.mjs';
import { isLMDB, meshed, request, startShardedCluster, waitForLocal } from './nodeDrainShared.mjs';

suite(
	'a sharded node restarted on the same boot',
	{ timeout: 600_000, skip: isLMDB && 'RocksDB own-origin recovery' },
	(ctx) => {
		let contexts;
		before(async () => {
			contexts = await startShardedCluster(ctx, [0, 1, 1]);
		});
		after(() => contexts && stopAndTeardownNodes(contexts.map((context) => context.harper)));

		test('reconnects to its co-owner and its cross-shard peer', async () => {
			const [, writer, coOwner] = contexts;
			const ids = ['own-1', 'own-3', 'own-5'];
			for (const id of ids) {
				const response = await request(writer.harper, `Drained/${id}`, { method: 'PUT', body: { id, body: id } });
				assert.ok(response.status < 300, JSON.stringify(response));
			}
			await waitForLocal(coOwner.harper, ids);
			await restartNode(writer.harper);
			await meshed(contexts, 'the cluster to reconnect after restarting a sharded node');
			// a link that keeps closing is connected for a moment after each handshake, so a write must also cross it
			const response = await request(coOwner.harper, 'Drained/own-7', {
				method: 'PUT',
				body: { id: 'own-7', body: 'own-7' },
			});
			assert.ok(response.status < 300, JSON.stringify(response));
			await waitForLocal(writer.harper, ['own-7']);
		});
	}
);
