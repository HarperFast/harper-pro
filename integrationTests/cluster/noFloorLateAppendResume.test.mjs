// harper-pro#1454: a write that reserved its key before another and committed after it, while the peer was down,
// must reach a peer that reconnects holding no floor for the origin, and no confirmation may count it first.
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { killHarper, startHarper } from '@harperfast/integration-testing';
import { stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';
import {
	holdWrite,
	isLMDB,
	localEntries,
	meshed,
	nodeOptions,
	request,
	startShardedCluster,
	upsert,
	waitForLocal,
} from './nodeDrainShared.mjs';

const DATABASE = 'unsharded';
const TABLE = 'unsharded.Unsharded';
const write = (context, id, options) =>
	upsert(context.harper, id, { database: DATABASE, table: 'Unsharded', ...options });

/** The origin's row on the peer's direct route from it: its floor and the highest key the peer applied from it. */
async function originRow(node, origin, signal) {
	const response = await request(node, `SeqRows/?database=${DATABASE}`, { signal });
	assert.equal(response.status, 200, JSON.stringify(response));
	return response.data.find((entry) => entry.route === origin)?.nodes.find((entry) => entry.origin === origin);
}

suite(
	'a late older-keyed write on a route with no floor',
	{ timeout: 600_000, skip: isLMDB && 'RocksDB append-order resume' },
	(ctx) => {
		let contexts;
		let origin, peer;

		before(async () => {
			contexts = await startShardedCluster(ctx, [0, 0], {
				// every receiver resumes with no floor; the first is otherwise certified on the first send pass
				env: { HARPER_TEST_WITHHOLD_ORIGIN_FLOORS: '1' },
				database: DATABASE,
				schema: 'type Unsharded @table(database: "unsharded") @export {\n\tid: ID @primaryKey\n\tbody: String\n}\n',
			});
			[origin, peer] = contexts;
		});

		after(() => contexts && stopAndTeardownNodes(contexts.map((context) => context.harper)));

		test('reaches a peer that reconnects after it committed, and confirms nothing before it', async () => {
			await write(origin, 'warm');
			await waitForLocal(peer.harper, ['warm'], TABLE);
			const held = await holdWrite(origin, 'late', { database: DATABASE, table: 'Unsharded' });
			try {
				await write(origin, 'newer');
				const applied = await waitForLocal(peer.harper, ['newer'], TABLE);
				const newerKey = applied.find((entry) => entry.id === 'newer').version;
				// a saved cursor still at 'warm' would resume below 'late', which the unfixed key rule also delivers
				await waitForCondition(
					async (signal) => (await originRow(peer.harper, origin.hostname, signal))?.originLogKey >= newerKey,
					{ description: "the peer to save its cursor for the origin at 'newer'" }
				);
				const row = await originRow(peer.harper, origin.hostname);
				assert.equal(row.closedFloor, null, 'the peer holds no floor for the origin');
				await killHarper(peer);
			} finally {
				await held.release();
			}
			const heldResult = await held.inFlight;
			assert.ok(heldResult.status < 300, `the held write committed: ${JSON.stringify(heldResult)}`);
			await startHarper(peer, nodeOptions(peer));
			await meshed(contexts, 'the peer to reconnect', DATABASE);

			// a marker acknowledged on the new link covers every write committed before this one, the late one included
			await write(origin, 'confirmed', { replicatedConfirmation: 1 });
			const confirmed = await localEntries(peer.harper, TABLE);
			assert.ok(
				confirmed.some((entry) => entry.id === 'late'),
				`a confirmed write returned before the peer held the late one: ${JSON.stringify(confirmed.map(({ id }) => id))}`
			);

			const entries = await waitForLocal(peer.harper, ['late', 'newer', 'confirmed'], TABLE, 30_000);
			const late = entries.find((entry) => entry.id === 'late');
			const newer = entries.find((entry) => entry.id === 'newer');
			assert.ok(late.version < newer.version, `late (${late.version}) reserved before newer (${newer.version})`);
		});
	}
);
