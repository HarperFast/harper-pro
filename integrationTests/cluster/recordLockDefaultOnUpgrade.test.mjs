/**
 * `replication.recordLocks` across the change of default (harper-pro#853): a cluster that ran with cluster
 * record locks off and no home map, restarted with the key unset as an upgrade leaves it, gets cluster-wide
 * locks on its first `lock()`; explicit `false` still opts out; and an LMDB node stays off and says so.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stopNodeProcess } from './clusterShared.mjs';
import {
	DB,
	call,
	clusterStatusOf,
	connectMesh,
	currentRow,
	nodeNames,
	putCounter,
	restartDefaultNode,
	startDefaultNode,
	stopNode,
	waitForCounter,
	waitForMesh,
} from './recordLockShared.mjs';

suite('an upgrade from a cluster with record locks off and no home map', { timeout: 600_000 }, (ctx) => {
	const contexts = [];
	let nodes;

	before(async () => {
		const started = await Promise.allSettled(
			Array.from({ length: 3 }, () => startDefaultNode(ctx.name, { recordLocks: false }))
		);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		nodes = contexts.map((c) => c.harper);
		await connectMesh(nodes);
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
	});

	test('explicit false refuses cluster locks, naming the switch, and writes no map', async () => {
		for (const node of nodes) {
			const result = await call(node, 'LockOnce/', { id: 'off', timeout: 2_000 });
			assert.equal(result.status, 503, node.hostname);
			assert.match(JSON.stringify(result.body), /replication\.recordLocks/);
			assert.equal((await currentRow(node)).active, undefined);
		}
	});

	test('restarted with the key unset, the first cluster locks establish generation 1 and stay exclusive', async () => {
		for (const node of nodes) await stopNodeProcess(node);
		for (const c of contexts) await restartDefaultNode(c, { recordLocks: null });
		nodes = contexts.map((c) => c.harper);
		await waitForMesh(nodes);
		const id = 'upgraded-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		const N = 12;
		const results = await Promise.all(
			Array.from({ length: N }, (_, i) => call(nodes[i % nodes.length], 'LockedIncrement/', { id }))
		);
		const failed = results.filter((result) => result.status !== 200);
		assert.deepEqual(failed, [], `every lock after the upgrade must succeed: ${JSON.stringify(failed)}`);
		assert.deepEqual(
			results.map((result) => result.body.n).sort((a, b) => a - b),
			Array.from({ length: N }, (_, i) => i + 1)
		);
		const names = [...(await nodeNames(nodes))].sort();
		for (const node of nodes) {
			const row = await currentRow(node);
			assert.equal(row.active?.generation, 1, `${node.hostname}: ${JSON.stringify(row)}`);
			assert.deepEqual(row.active.homes, names);
		}
	});
});

suite('cluster record locks on LMDB with the key unset', { timeout: 300_000 }, (ctx) => {
	let context;

	before(async () => {
		context = await startDefaultNode(ctx.name, { env: { HARPER_STORAGE_ENGINE: 'lmdb' } });
	});

	after(async () => {
		if (context) await stopNode(context);
	});

	test('stay off: no coordinator is assigned, and lock() is refused by the engine', async () => {
		const status = await clusterStatusOf(context.harper);
		assert.equal(
			status.recordLocks?.[DB],
			undefined,
			`no record-lock coordination: ${JSON.stringify(status.recordLocks)}`
		);
		const result = await call(context.harper, 'LockOnce/', { id: 'lmdb', timeout: 2_000 });
		assert.equal(result.status, 501);
		assert.match(JSON.stringify(result.body), /not supported on LMDB/);
	});
});
