// A receiver moves past a blob its source reports it cannot send (harper-pro#403), so the record arrives without
// its bytes. A confirmation marker acknowledged after that skip would confirm a write the peer does not hold, so
// replicatedConfirmation must not succeed (harper-pro#1351 path 2).
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';
import { isLMDB, localEntries, request, startShardedCluster } from './nodeDrainShared.mjs';

const confirm = { 'X-Replicate-To': '*;confirm=1' };

suite(
	'replicatedConfirmation of a write whose blob its source cannot send',
	{ timeout: 300_000, skip: isLMDB && 'RocksDB markers' },
	(ctx) => {
		let contexts;
		let origin, peer;

		before(async () => {
			contexts = await startShardedCluster(ctx, [0, 0], {
				env: { HARPER_TEST_FAIL_BLOB_READS: '1' },
				database: 'unsharded',
				schema: 'type BlobDoc @table(database: "unsharded") @export {\n\tid: ID @primaryKey\n\tdata: Blob\n}\n',
			});
			[origin, peer] = contexts;
		});

		after(() => contexts && stopAndTeardownNodes(contexts.map((context) => context.harper)));

		test('is not confirmed by a peer that skipped the blob', async () => {
			const plain = await request(origin.harper, 'BlobDoc/plain-0', {
				method: 'PUT',
				body: { id: 'plain-0' },
				headers: confirm,
			});
			assert.ok(plain.status < 300, `a write without a blob is confirmed: ${JSON.stringify(plain)}`);

			let settled;
			request(origin.harper, 'BlobWrite', {
				method: 'POST',
				body: { database: 'unsharded', table: 'BlobDoc', id: 'blob-0' },
				headers: confirm,
				signal: AbortSignal.timeout(120_000),
			}).then(
				(result) => (settled = result),
				(error) => (settled = { error: error.message })
			);
			await waitForCondition(
				async (signal) =>
					(await localEntries(peer.harper, 'unsharded.BlobDoc', signal)).some((entry) => entry.id === 'blob-0'),
				{ description: 'the record to reach the peer without its blob' }
			);
			await delay(5_000);
			assert.ok(!settled || settled.status >= 300 || settled.error, `confirmed: ${JSON.stringify(settled)}`);
		});
	}
);
