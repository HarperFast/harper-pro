// A write that reserved its key before another and committed after it, while the receiving peer was down, must
// reach that peer when it reconnects on an ordinary (non-sharded) route. The peer's received position is above the
// late key, so only a resume below the certified floor re-sends it. Floors are level 1 here (no generation), so
// the route is not checkpoint-grade and does not take the floor-only resume (harper-pro#1351 path 1).
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { killHarper, startHarper } from '@harperfast/integration-testing';
import { stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';
import {
	directFloor,
	holdWrite,
	isLMDB,
	meshed,
	nodeOptions,
	startShardedCluster,
	upsert,
	waitForLocal,
} from './nodeDrainShared.mjs';

const DATABASE = 'unsharded';
const TABLE = 'unsharded.Unsharded';
const write = (context, id) => upsert(context.harper, id, { database: DATABASE, table: 'Unsharded' });

suite(
	'a late older-keyed write on a non-sharded route',
	{ timeout: 600_000, skip: isLMDB && 'RocksDB floors' },
	(ctx) => {
		let contexts;
		let origin, peer;

		before(async () => {
			contexts = await startShardedCluster(ctx, [0, 0], {
				env: { HARPER_TEST_FORCE_ORIGIN_FLOORS_LEVEL_1: '1' },
				// no sharded table: level-1 floors cannot admit a sharding route
				database: DATABASE,
				schema: 'type Unsharded @table(database: "unsharded") @export {\n\tid: ID @primaryKey\n\tbody: String\n}\n',
			});
			[origin, peer] = contexts;
		});

		after(() => contexts && stopAndTeardownNodes(contexts.map((context) => context.harper)));

		test('reaches a peer that reconnects after it committed, below a newer key the peer already holds', async () => {
			await write(origin, 'warm');
			await waitForLocal(peer.harper, ['warm'], TABLE);
			const held = await holdWrite(origin, 'late', { database: DATABASE, table: 'Unsharded' });
			try {
				await write(origin, 'newer');
				await waitForLocal(peer.harper, ['newer'], TABLE);
				await waitForCondition(
					async (signal) => (await directFloor(peer.harper, origin.hostname, signal, DATABASE)) > 0,
					{ description: 'the peer to record a certified floor for the origin' }
				);
				await killHarper(peer);
			} finally {
				await held.release();
			}
			const heldResult = await held.inFlight;
			assert.ok(heldResult.status < 300, `the held write committed: ${JSON.stringify(heldResult)}`);
			await startHarper(peer, nodeOptions(peer));
			await meshed(contexts, 'the peer to reconnect', DATABASE);

			const entries = await waitForLocal(peer.harper, ['late', 'newer'], TABLE, 30_000);
			const late = entries.find((entry) => entry.id === 'late');
			const newer = entries.find((entry) => entry.id === 'newer');
			assert.ok(late.version < newer.version, `late (${late.version}) reserved before newer (${newer.version})`);
		});
	}
);
