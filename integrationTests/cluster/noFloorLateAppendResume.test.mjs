// harper-pro#1454: a write that reserved its key before another and committed after it, while the peer was down,
// must reach a peer that reconnects holding no floor for the origin, and no confirmation may count it first.
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { killHarper, startHarper } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';
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

// every receiver resumes with no floor; the first is otherwise certified on the first send pass
const startNoFloorCluster = (ctx) =>
	startShardedCluster(ctx, [0, 0], {
		env: { HARPER_TEST_WITHHOLD_ORIGIN_FLOORS: '1' },
		database: DATABASE,
		schema: 'type Unsharded @table(database: "unsharded") @export {\n\tid: ID @primaryKey\n\tbody: String\n}\n',
	});

/** Waits until the peer's saved cursor for the origin covers `id`, which the peer must already hold. */
async function waitForCursorAt(origin, peer, id) {
	const applied = await waitForLocal(peer.harper, [id], TABLE);
	const key = applied.find((entry) => entry.id === id).version;
	await waitForCondition(
		async (signal) => (await originRow(peer.harper, origin.hostname, signal))?.originLogKey >= key,
		{ description: `the peer to save its cursor for the origin at '${id}'` }
	);
	assert.equal(
		(await originRow(peer.harper, origin.hostname)).closedFloor,
		null,
		'the peer holds no floor for the origin'
	);
}

suite(
	'a late older-keyed write on a route with no floor',
	{ timeout: 600_000, skip: isLMDB && 'RocksDB append-order resume' },
	(ctx) => {
		let contexts;
		let origin, peer;

		before(async () => {
			contexts = await startNoFloorCluster(ctx);
			[origin, peer] = contexts;
		});

		after(() => contexts && stopAndTeardownNodes(contexts.map((context) => context.harper)));

		test('reaches a peer that reconnects after it committed, and confirms nothing before it', async () => {
			await write(origin, 'warm');
			await waitForLocal(peer.harper, ['warm'], TABLE);
			const held = await holdWrite(origin, 'late', { database: DATABASE, table: 'Unsharded' });
			try {
				await write(origin, 'newer');
				// a saved cursor still at 'warm' would resume below 'late', which the unfixed key rule also delivers
				await waitForCursorAt(origin, peer, 'newer');
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

suite(
	'a late write keyed before an add_node start_time cutoff on a route with no floor',
	{ timeout: 600_000, skip: isLMDB && 'RocksDB append-order resume' },
	(ctx) => {
		let contexts;
		let origin, peer;

		before(async () => {
			contexts = await startNoFloorCluster(ctx);
			[origin, peer] = contexts;
		});

		after(() => contexts && stopAndTeardownNodes(contexts.map((context) => context.harper)));

		test('stays excluded when the peer resumes the origin past its anchor', async () => {
			await write(origin, 'warm');
			await waitForLocal(peer.harper, ['warm'], TABLE);
			const held = await holdWrite(origin, 'before-cutoff', { database: DATABASE, table: 'Unsharded' });
			try {
				const cutoff = Date.now() + 5;
				await delay(20);
				await write(origin, 'newer');
				await waitForCursorAt(origin, peer, 'newer');
				const { operation_token: token } = await sendOperation(origin.harper, {
					operation: 'create_authentication_tokens',
					authorization: origin.harper.admin,
				});
				await sendOperation(peer.harper, {
					operation: 'update_node',
					hostname: origin.hostname,
					start_time: new Date(cutoff).toISOString(),
					authorization: 'Bearer ' + token,
					rejectUnauthorized: false,
				});
				await killHarper(peer);
			} finally {
				await held.release();
			}
			const heldResult = await held.inFlight;
			assert.ok(heldResult.status < 300, `the held write committed: ${JSON.stringify(heldResult)}`);
			await startHarper(peer, nodeOptions(peer));
			await meshed(contexts, 'the peer to reconnect', DATABASE);

			// the peer has resumed past its anchor once a later write arrives, so the earlier one had its chance
			await write(origin, 'after-reconnect');
			const entries = await waitForLocal(peer.harper, ['after-reconnect'], TABLE, 30_000);
			assert.ok(
				!entries.some((entry) => entry.id === 'before-cutoff'),
				`a write keyed before the start_time cutoff reached the peer: ${JSON.stringify(entries.map(({ id }) => id))}`
			);
		});

		// the cutoff set above still holds, so this late write differs from the one before only in its side of it
		test('arrives when it reserved its key after the cutoff', async () => {
			const held = await holdWrite(origin, 'after-cutoff', { database: DATABASE, table: 'Unsharded' });
			try {
				await write(origin, 'newer-again');
				await waitForCursorAt(origin, peer, 'newer-again');
				await killHarper(peer);
			} finally {
				await held.release();
			}
			const heldResult = await held.inFlight;
			assert.ok(heldResult.status < 300, `the held write committed: ${JSON.stringify(heldResult)}`);
			await startHarper(peer, nodeOptions(peer));
			await meshed(contexts, 'the peer to reconnect', DATABASE);

			const entries = await waitForLocal(peer.harper, ['after-cutoff', 'newer-again'], TABLE, 30_000);
			const late = entries.find((entry) => entry.id === 'after-cutoff');
			const newer = entries.find((entry) => entry.id === 'newer-again');
			assert.ok(
				late.version < newer.version,
				`after-cutoff (${late.version}) reserved before newer-again (${newer.version})`
			);
			assert.ok(
				!entries.some((entry) => entry.id === 'before-cutoff'),
				'the write keyed before the cutoff arrived on a later reconnect'
			);
		});
	}
);
