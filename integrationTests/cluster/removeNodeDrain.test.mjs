// remove_node of a live node waits until every peer that must hold its writes has them (harper-pro#1348).
// Shard 0 (owner, coOwner) owns ids ending in an even digit; shard 1 (keeper, drained, restarted, forced) the odd
// ones. `unsharded.Unsharded` replicates to every node. Removal runs on the co-owner, so pausing a removed node's
// link to the owner never holds the coordinator's own operation traffic.
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { killHarper, startHarper } from '@harperfast/integration-testing';
import { postOperation, restartNode, sendOperation, stopAndTeardownNodes, stopNodeProcess } from './clusterShared.mjs';
import {
	isLMDB,
	localEntries,
	meshed,
	nodeOptions,
	pauseLink,
	put,
	request,
	resumeLink,
	startShardedCluster,
	upsert,
	waitForLocal,
} from './nodeDrainShared.mjs';

async function removeNode(coordinator, target, options = {}) {
	return postOperation(
		coordinator,
		{ operation: 'remove_node', hostname: target.hostname, ...options },
		{ signal: AbortSignal.timeout(600_000) }
	);
}

async function members(node) {
	const rows = await sendOperation(node, {
		operation: 'search_by_value',
		database: 'system',
		table: 'hdb_nodes',
		search_attribute: 'name',
		search_value: '*',
		get_attributes: ['name'],
	});
	return rows.map((row) => row.name).sort();
}

// a removed node is out of its shard, so sharding may refuse the write; the fence must not
async function writeNotFenced(context, id) {
	const response = await request(context.harper, `Drained/${id}`, { method: 'PUT', body: { id, body: id } });
	assert.doesNotMatch(JSON.stringify(response.data ?? ''), /being removed from its cluster/, JSON.stringify(response));
}

async function writeRefused(context, id) {
	const response = await request(context.harper, `Drained/${id}`, { method: 'PUT', body: { id, body: id } });
	assert.equal(response.status, 503, JSON.stringify(response));
	assert.match(JSON.stringify(response.data), /being removed from its cluster/);
}

suite('remove_node drains a live node', { timeout: 1_200_000, skip: isLMDB && 'RocksDB floors' }, (ctx) => {
	let contexts;
	let owner, coOwner, keeper, drained, restarted, forced;

	before(async () => {
		contexts = await startShardedCluster(ctx, [0, 0, 1, 1, 1, 1]);
		[owner, coOwner, keeper, drained, restarted, forced] = contexts;
	});

	after(() => contexts && stopAndTeardownNodes(contexts.map((context) => context.harper)));

	test('a node with writes still held on its link to an owner is removed only once the owner has them', async () => {
		await pauseLink(drained, owner);
		try {
			for (const id of ['backlog-0', 'backlog-2', 'backlog-1', 'backlog-3']) await put(drained.harper, id);
			await upsert(drained.harper, 'backlog-plain', { database: 'unsharded', table: 'Unsharded' });
			let settled = false;
			const removal = removeNode(coOwner.harper, drained, { timeout: 120_000 }).finally(() => (settled = true));
			await new Promise((resolve) => setTimeout(resolve, 8_000));
			assert.equal(settled, false, 'removed while its writes were still held on the paused link');
			await writeRefused(drained, 'after-fence-0');
			assert.ok((await members(coOwner.harper)).includes(drained.hostname));
			await resumeLink(drained, owner);
			const result = await removal;
			assert.equal(result.status, 200, JSON.stringify(result));
			assert.match(JSON.stringify(result.body), /its writes reached \d+ peers before it was removed/);
			// the removal notice lifts the fence: what the node writes from now on is its own
			await writeNotFenced(drained, 'after-removal-0');
		} finally {
			await resumeLink(drained, owner);
		}
		await stopNodeProcess(drained.harper);
		// read what each survivor stores locally: a read through to the removed node cannot mask a loss
		for (const node of [owner.harper, coOwner.harper])
			assert.deepEqual(
				(await localEntries(node))
					.filter((entry) => entry.id.startsWith('backlog-'))
					.map((entry) => entry.id)
					.sort(),
				['backlog-0', 'backlog-2']
			);
		assert.ok((await localEntries(keeper.harper)).some((entry) => entry.id === 'backlog-1'));
		assert.ok((await localEntries(keeper.harper)).some((entry) => entry.id === 'backlog-3'));
		for (const node of [owner.harper, coOwner.harper, keeper.harper])
			assert.ok((await localEntries(node, 'unsharded.Unsharded')).some((entry) => entry.id === 'backlog-plain'));
		assert.ok(!(await members(coOwner.harper)).includes(drained.hostname));
	});

	test('a removal that cannot reach an owner times out, leaving the node fenced and a member', async () => {
		await put(restarted.harper, 'before-timeout-0');
		await waitForLocal(owner.harper, ['before-timeout-0']);
		await killHarper(owner);
		try {
			await put(restarted.harper, 'while-owner-down-1');
			const result = await removeNode(coOwner.harper, restarted, { timeout: 10_000 });
			assert.equal(result.status, 504, JSON.stringify(result));
			assert.match(JSON.stringify(result.body), new RegExp(`${owner.hostname.replaceAll('.', '\\.')}`));
			assert.match(JSON.stringify(result.body), /still refuses local writes and stays a member/);
			assert.ok((await members(coOwner.harper)).includes(restarted.hostname));
			await writeRefused(restarted, 'refused-while-pending-0');
			// a database created after the fence opens fenced too: no receipt would cover a write to it
			await sendOperation(restarted.harper, {
				operation: 'create_table',
				database: 'created_while_fenced',
				table: 'Late',
				primary_key: 'id',
			});
			const late = await postOperation(restarted.harper, {
				operation: 'upsert',
				database: 'created_while_fenced',
				table: 'Late',
				records: [{ id: 'late-0' }],
			});
			assert.match(JSON.stringify(late.body), /being removed from its cluster/, JSON.stringify(late));
		} finally {
			await startHarper(owner, nodeOptions(owner));
		}
	});

	test('the fence survives a restart, and the removal completes after it', async () => {
		await restartNode(restarted.harper);
		await meshed(
			contexts.filter((context) => context !== drained),
			'the cluster to reconnect after restarting the fenced node'
		);
		await writeRefused(restarted, 'refused-after-restart-0');
		const result = await removeNode(coOwner.harper, restarted, { timeout: 120_000 });
		assert.equal(result.status, 200, JSON.stringify(result));
		await writeNotFenced(restarted, 'after-restarted-removal-1');
		await stopNodeProcess(restarted.harper);
		await waitForLocal(owner.harper, ['before-timeout-0'], 'Drained', 10_000);
		assert.ok((await localEntries(keeper.harper)).some((entry) => entry.id === 'while-owner-down-1'));
		assert.ok(!(await members(coOwner.harper)).includes(restarted.hostname));
	});

	test('force removes a node at once, without the wait', async () => {
		await pauseLink(forced, owner);
		try {
			await put(forced.harper, 'forced-0');
			const started = Date.now();
			const result = await removeNode(coOwner.harper, forced, { force: true });
			assert.equal(result.status, 200, JSON.stringify(result));
			assert.ok(Date.now() - started < 10_000, `force waited ${Date.now() - started}ms`);
			assert.match(JSON.stringify(result.body), /writes only it held may be lost/);
			assert.ok(!(await members(coOwner.harper)).includes(forced.hostname));
		} finally {
			await resumeLink(forced, owner);
		}
	});
});
