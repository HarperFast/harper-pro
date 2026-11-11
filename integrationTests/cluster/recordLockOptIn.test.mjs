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
import { waitForCondition } from './clusterShared.mjs';

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

		test('a conditional REST write checks its precondition without a lock: a match succeeds, a stale ETag is 412', async () => {
			const id = 'conditional-' + label;
			await putCounter(nodes[0], id, 1);
			await waitForCounter(nodes, id, 1);
			const read = await fetch(`${nodes[1].httpURL}/Counter/${id}`, { headers: { Accept: 'application/json' } });
			const etag = read.headers.get('etag');
			assert.ok(etag, 'a read answers an ETag to condition on');
			await read.text();
			const conditionalPut = async (ifMatch, n) => {
				const write = await fetch(`${nodes[1].httpURL}/Counter/${id}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json', 'If-Match': ifMatch },
					body: JSON.stringify({ id, n }),
				});
				return { status: write.status, body: await write.text() };
			};
			const matched = await conditionalPut(etag, 2);
			assert.ok(matched.status >= 200 && matched.status < 300, `${matched.status} ${matched.body}`);
			await waitForCounter(nodes, id, 2);
			const stale = await conditionalPut(etag, 3);
			assert.equal(stale.status, 412, stale.body);
			for (const node of nodes) assert.equal((await counter(node, id))?.n, 2, node.hostname);
		});

		test('an unconditional write still replicates', async () => {
			const id = 'plain-' + label;
			await putCounter(nodes[1], id, 7);
			await waitForCounter(nodes, id, 7);
		});
	});
}

suite('cluster record locks enabled with no home map applied', { timeout: 300_000 }, (ctx) => {
	let context;

	before(async () => {
		context = await startNode(ctx.name, {}, 1, undefined, true);
	});

	after(async () => {
		if (context) await stopNode(context);
	});

	test('a cluster lock() answers 503 naming record_lock_apply_homes, not the disabled-switch message', async () => {
		// Until the coordination incarnation is assigned, lock() answers a startup 503 instead.
		const result = await waitForCondition(
			async (signal) => {
				const attempt = await call(context.harper, 'LockOnce/', { id: 'enabled-no-map', timeout: 2_000 }, signal);
				return /record_lock_apply_homes/.test(JSON.stringify(attempt.body)) ? attempt : undefined;
			},
			{ timeoutMs: 60_000, description: 'a lock() answer naming record_lock_apply_homes' }
		);
		assert.equal(result.status, 503, JSON.stringify(result.body));
		assert.match(JSON.stringify(result.body), /record_lock_apply_homes/);
		assert.doesNotMatch(JSON.stringify(result.body), /not enabled on this node/);

		const id = 'enabled-no-map-conditional';
		await putCounter(context.harper, id, 1);
		const read = await fetch(`${context.harper.httpURL}/Counter/${id}`, { headers: { Accept: 'application/json' } });
		const etag = read.headers.get('etag');
		assert.ok(etag, 'a read answers an ETag to condition on');
		await read.text();
		const write = await waitForCondition(
			async (signal) => {
				const attempt = await fetch(`${context.harper.httpURL}/Counter/${id}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json', 'If-Match': etag },
					body: JSON.stringify({ id, n: 2 }),
					signal,
				});
				const text = await attempt.text();
				return /record_lock_apply_homes/.test(text) ? { status: attempt.status, text } : undefined;
			},
			{ timeoutMs: 60_000, description: 'a refused conditional PUT naming record_lock_apply_homes' }
		);
		const body = write.text;
		assert.equal(write.status, 503, body);
		assert.match(body, /record_lock_apply_homes/);
		assert.equal((await counter(context.harper, id))?.n, 1);
	});
});

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

	test('a conditional REST write takes no lock: a match succeeds, a stale ETag is 412', async () => {
		const id = 'lmdb-conditional';
		await putCounter(context.harper, id, 1);
		const read = await fetch(`${context.harper.httpURL}/Counter/${id}`, { headers: { Accept: 'application/json' } });
		const etag = read.headers.get('etag');
		assert.ok(etag, 'a read answers an ETag to condition on');
		await read.text();
		const conditionalPut = async (n) => {
			const write = await fetch(`${context.harper.httpURL}/Counter/${id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json', 'If-Match': etag },
				body: JSON.stringify({ id, n }),
				signal: AbortSignal.timeout(30_000),
			});
			return { status: write.status, body: await write.text() };
		};
		const matched = await conditionalPut(2);
		assert.ok(matched.status >= 200 && matched.status < 300, `${matched.status} ${matched.body}`);
		const stale = await conditionalPut(3);
		assert.equal(stale.status, 412, stale.body);
		assert.equal((await counter(context.harper, id))?.n, 2);
	});
});
