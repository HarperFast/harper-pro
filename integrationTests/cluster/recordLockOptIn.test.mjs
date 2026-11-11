import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
	DB,
	call,
	clusterStatusOf,
	connectMesh,
	counter,
	operation,
	putCounter,
	startNode,
	stopNode,
	waitForCounter,
} from './recordLockShared.mjs';

const FIX = /replication\.recordLocks: true.*record_lock_apply_homes/;

for (const [label, recordLocks] of [
	['unset', null],
	['false', false],
]) {
	suite(`cluster record locks with replication.recordLocks ${label}`, { timeout: 300_000 }, (ctx) => {
		const contexts = [];
		let nodes;

		before(async () => {
			const started = await Promise.allSettled(
				Array.from({ length: 2 }, () => startNode(ctx.name, {}, 1, undefined, recordLocks))
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

		test('a cluster lock() answers 503 naming the fix, and no home-map table is created', async () => {
			for (const node of nodes) {
				const result = await call(node, 'LockOnce/', { id: 'off-' + label, timeout: 2_000 });
				assert.equal(result.status, 503, node.hostname);
				assert.match(JSON.stringify(result.body), FIX);
				const system = await operation(node, { operation: 'describe_database', database: 'system' });
				assert.equal(system.status, 200, JSON.stringify(system.body));
				assert.ok(system.body.hdb_nodes, 'describe_database lists system tables by name');
				assert.equal(system.body.hdb_record_lock_homes, undefined, node.hostname);
			}
		});

		test('a conditional REST write answers the same 503 and leaves the record unchanged', async () => {
			const id = 'conditional-' + label;
			await putCounter(nodes[0], id, 1);
			await waitForCounter(nodes, id, 1);
			const read = await fetch(`${nodes[1].httpURL}/Counter/${id}`, { headers: { Accept: 'application/json' } });
			const etag = read.headers.get('etag');
			assert.ok(etag, 'a read answers an ETag to condition on');
			await read.text();
			const write = await fetch(`${nodes[1].httpURL}/Counter/${id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json', 'If-Match': etag },
				body: JSON.stringify({ id, n: 2 }),
			});
			const body = await write.text();
			assert.equal(write.status, 503, body);
			assert.match(body, FIX);
			for (const node of nodes) assert.equal((await counter(node, id))?.n, 1, node.hostname);
		});

		test('an unconditional write still replicates', async () => {
			const id = 'plain-' + label;
			await putCounter(nodes[1], id, 7);
			await waitForCounter(nodes, id, 7);
		});
	});
}

suite('cluster record locks on LMDB with the key unset', { timeout: 300_000 }, (ctx) => {
	let context;

	before(async () => {
		context = await startNode(ctx.name, { HARPER_STORAGE_ENGINE: 'lmdb' }, 1, undefined, null);
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
