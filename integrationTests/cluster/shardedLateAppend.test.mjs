// A node's writes to a slot it does not own reach the owner only on its direct cross-shard route (ids ending in 0
// belong to shard 0). A write that reserved its key
// before another and committed after it is a late, older-keyed entry: it must survive a reconnect of that route
// (harper-pro#1351 path 1), and replicatedConfirmation must not count it delivered before it is (path 2).
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { killHarper, startHarper } from '@harperfast/integration-testing';
import { stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';
import {
	directFloor,
	holdWrite,
	isLMDB,
	localEntries,
	meshed,
	nodeOptions,
	pauseLink,
	put,
	resumeLink,
	startShardedCluster,
	upsert,
	waitForLocal,
} from './nodeDrainShared.mjs';

suite('late older-keyed writes from a non-owner', { timeout: 900_000, skip: isLMDB && 'RocksDB floors' }, (ctx) => {
	let contexts;
	let owner, coOwner, replica;

	before(async () => {
		contexts = await startShardedCluster(ctx, [0, 0, 1, 1]);
		[owner, coOwner, replica] = contexts;
	});

	after(() => contexts && stopAndTeardownNodes(contexts.map((context) => context.harper)));

	test('an owner that reconnects receives a write committed after a newer-keyed one it already holds', async () => {
		await put(replica.harper, 'warm-a0');
		await waitForLocal(owner.harper, ['warm-a0']);
		const held = await holdWrite(replica, 'late-a0');
		await upsert(replica.harper, 'newer-b0');
		await waitForLocal(owner.harper, ['newer-b0']);
		// the route certifies floors: a resume can start below one instead of at the highest key received
		await waitForCondition(async (signal) => (await directFloor(owner.harper, replica.hostname, signal)) > 0, {
			description: 'the owner to record a certified floor for the non-owner',
		});

		await killHarper(owner);
		await held.release();
		await startHarper(owner, nodeOptions(owner));
		await meshed(contexts, 'the owner to reconnect');
		const heldResult = await held.inFlight;
		assert.ok(heldResult.status < 300, `the held write committed: ${JSON.stringify(heldResult)}`);

		const entries = await waitForLocal(owner.harper, ['late-a0', 'newer-b0']);
		const late = entries.find((entry) => entry.id === 'late-a0');
		const newer = entries.find((entry) => entry.id === 'newer-b0');
		assert.ok(late.version < newer.version, `late-a0 (${late.version}) reserved before newer-b0 (${newer.version})`);
	});

	test('replicatedConfirmation of a late older-keyed write waits for its delivery', async () => {
		const confirm = { 'X-Replicate-To': '*;confirm=1' };
		const held = await holdWrite(replica, 'confirm-late0', { headers: confirm });
		await upsert(replica.harper, 'confirm-newer0', { replicatedConfirmation: 1 });
		await waitForLocal(owner.harper, ['confirm-newer0']);

		// both owners are residents of the record: either one's acknowledgement would confirm it
		await pauseLink(replica, owner);
		await pauseLink(replica, coOwner);
		let settled = false;
		const confirmation = held.inFlight.then((result) => ((settled = true), result));
		try {
			await held.release();
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			assert.equal(settled, false, 'confirmed while its frames were still held on the paused link');
			assert.ok(
				!(await localEntries(owner.harper)).some((entry) => entry.id === 'confirm-late0'),
				'delivered while paused'
			);
		} finally {
			await resumeLink(replica, owner);
			await resumeLink(replica, coOwner);
		}
		const result = await confirmation;
		assert.ok(result.status < 300, JSON.stringify(result));
		await waitForLocal(owner.harper, ['confirm-late0'], 'Drained', 10_000);
	});

	test('replicatedConfirmation of the last write on an idle link settles once delivered', async () => {
		const response = await put(replica.harper, 'confirm-idle-tail0', { headers: { 'X-Replicate-To': '*;confirm=1' } });
		assert.ok(response.status < 300);
		await waitForLocal(owner.harper, ['confirm-idle-tail0'], 'Drained', 10_000);
	});
});
