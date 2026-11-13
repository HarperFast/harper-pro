import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	DB,
	call,
	clusterStatusOf,
	connectMesh,
	counter,
	operation,
	putCounter,
	restartStoppedNode,
	startNode,
	stopNode,
	waitForCounter,
} from './recordLockShared.mjs';
import { logMark, readLogSince, sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

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

// A node upgraded in place from v4 keeps its `.mdb` databases on LMDB whatever storage.engine says.
suite('cluster record locks on a node with a replicated database opened on LMDB', { timeout: 600_000 }, (ctx) => {
	const LEGACY = 'legacy';
	let lmdbSource;
	let node;
	let peer;

	const engines = async (target) => {
		const all = await sendOperation(target, { operation: 'describe_all', skip_record_count: true });
		return { data: all[DB]?.Counter?.engine, legacy: all[LEGACY]?.Old?.engine };
	};
	const waitForObservedLevel = (observer, target, accept, description) => {
		let last;
		return waitForCondition(
			async (signal) => {
				const status = await clusterStatusOf(observer, signal).catch(() => undefined);
				const connection = status?.connections.find((entry) => entry.name === target.nodeName);
				const socket = connection?.database_sockets.find((entry) => entry.database === DB && entry.connected);
				if (!socket?.peerCapabilities) return undefined;
				last = socket.peerCapabilities.recordLocks ?? 0;
				return accept(last) ? { level: last } : undefined;
			},
			{
				timeoutMs: 90_000,
				description: () => `${observer.hostname} to see ${description} from ${target.hostname}; last ${last}`,
			}
		);
	};

	before(async () => {
		lmdbSource = await startNode(ctx.name, { HARPER_STORAGE_ENGINE: 'lmdb' }, 1, undefined, null);
		await sendOperation(lmdbSource.harper, {
			operation: 'create_table',
			database: LEGACY,
			table: 'Old',
			primary_key: 'id',
		});
		await sendOperation(lmdbSource.harper, {
			operation: 'insert',
			database: LEGACY,
			table: 'Old',
			records: [{ id: 'v4' }],
		});
		await stopNodeProcess(lmdbSource.harper);

		node = await startNode(ctx.name, {}, 2, undefined, true, [LEGACY]);
		peer = await startNode(ctx.name, {}, 1, undefined, true, [LEGACY]);
		await connectMesh([node.harper, peer.harper]);
		for (const context of [node, peer]) context.harper.nodeName = (await clusterStatusOf(context.harper)).node_name;
	});

	after(async () => {
		for (const context of [peer, node, lmdbSource]) if (context) await stopNode(context);
	});

	test('a RocksDB-only node enables record locks as before', async () => {
		assert.deepEqual(await engines(node.harper), { data: 'rocksdb', legacy: undefined });
		const result = await waitForCondition(
			async (signal) => {
				const attempt = await call(node.harper, 'LockOnce/', { id: 'rocks-only', timeout: 2_000 }, signal);
				return /record_lock_apply_homes/.test(JSON.stringify(attempt.body)) ? attempt : undefined;
			},
			{ timeoutMs: 60_000, description: 'a lock() answer naming record_lock_apply_homes' }
		);
		assert.equal(result.status, 503);
		assert.doesNotMatch(JSON.stringify(result.body), /not enabled on this node|opened on LMDB/);
		await waitForObservedLevel(peer.harper, node.harper, (level) => level > 0, 'a record-lock capability level');
	});

	test('with an LMDB database replicated, it starts with record locks off and says why', async () => {
		const mark = await logMark(node.harper);
		await stopNodeProcess(node.harper);
		await copyFile(
			join(lmdbSource.harper.dataRootDir, 'database', `${LEGACY}.mdb`),
			join(node.harper.dataRootDir, 'database', `${LEGACY}.mdb`)
		);
		await restartStoppedNode(node, {}, 2);
		node.harper.nodeName = (await clusterStatusOf(node.harper)).node_name;

		assert.deepEqual(await engines(node.harper), { data: 'rocksdb', legacy: 'lmdb' });
		const describedTable = await sendOperation(node.harper, {
			operation: 'describe_table',
			database: LEGACY,
			table: 'Old',
		});
		assert.equal(describedTable.engine, 'lmdb');

		const log = await readLogSince(node.harper, mark);
		assert.match(log, /cluster record locks stay disabled because these are opened on LMDB: legacy\b/);
		assert.equal(log.match(/these are opened on LMDB/g).length, 1, 'logged once, by the main thread');

		const result = await call(node.harper, 'LockOnce/', { id: 'mixed', timeout: 2_000 });
		assert.equal(result.status, 503, JSON.stringify(result.body));
		assert.match(JSON.stringify(result.body), /opened on LMDB/);
		assert.doesNotMatch(JSON.stringify(result.body), /legacy/);
		const status = await clusterStatusOf(node.harper);
		assert.equal(status.recordLocks?.[DB], undefined, JSON.stringify(status.recordLocks));
		await waitForObservedLevel(peer.harper, node.harper, (level) => level === 0, 'record-lock level 0');

		await putCounter(node.harper, 'mixed-plain', 3);
		await waitForCounter([node.harper, peer.harper], 'mixed-plain', 3);
	});

	test('migrating the LMDB database with storage.migrateOnStart turns record locks on in that same start', async () => {
		const mark = await logMark(node.harper);
		await stopNodeProcess(node.harper);
		await restartStoppedNode(node, { STORAGE_MIGRATEONSTART: 'true' }, 2);
		node.harper.nodeName = (await clusterStatusOf(node.harper)).node_name;

		assert.deepEqual(await engines(node.harper), { data: 'rocksdb', legacy: 'rocksdb' });
		const records = await sendOperation(node.harper, {
			operation: 'search_by_id',
			database: LEGACY,
			table: 'Old',
			ids: ['v4'],
			get_attributes: ['*'],
		});
		assert.equal(records.length, 1, 'the migrated record is readable');
		assert.doesNotMatch(await readLogSince(node.harper, mark), /these are opened on LMDB/);
		const result = await waitForCondition(
			async (signal) => {
				const attempt = await call(node.harper, 'LockOnce/', { id: 'migrated', timeout: 2_000 }, signal);
				return /record_lock_apply_homes/.test(JSON.stringify(attempt.body)) ? attempt : undefined;
			},
			{ timeoutMs: 60_000, description: 'a lock() answer naming record_lock_apply_homes' }
		);
		assert.equal(result.status, 503);
		await waitForObservedLevel(peer.harper, node.harper, (level) => level > 0, 'a record-lock capability level');
	});
});
