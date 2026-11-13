/**
 * Reproduction for harper-pro#1364: a RocksDB node that loses the unsynced tail of its own transaction
 * log (power loss) after those writes replicated does not get them back from its peers.
 *
 * Fault model. Table writes skip RocksDB's WAL (`openRocksDatabase`, `disableWAL ??= true`), so between
 * memtable flushes the transaction log is the only on-disk record of a commit, and it is appended to the
 * page cache without an fsync. rocksdb-js syncs log files only when a memtable flush begins, when an
 * abort marker is written, and before retention deletes a store's last file. A power loss keeps every
 * fsynced byte and may drop any page-cache write. `kill -9` drops the memtable but keeps the page cache,
 * so the test drops the page cache's share by hand: it restores A's own-origin log store (`local`) to a
 * copy taken while A was idle, before the writes. It checks that no flush started and no purge ran in
 * between; it does not check for abort markers or kernel writeback, so the restore is a forced
 * truncation to a state power loss can leave, not proof that this run's bytes were unsynced. Every other
 * file keeps what was written (the state most favorable to recovery).
 *
 * The expected behavior fails on main, so those two tests are `todo`. They run in the order a fixed
 * node would meet them: a lock right after the reconnect (before any catch-up could hide a stale admit),
 * then convergence within a bounded wait.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readNodePid, sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';
import {
	DB,
	bootstrapHomeMap,
	call,
	connectMesh,
	counter,
	keyHomedOn,
	putCounter,
	restartStoppedNode,
	startNode,
	stopNode,
	waitForCounter,
	waitForMesh,
	waitForRing,
} from './recordLockShared.mjs';

const ISSUE = 'harper-pro#1364: a restarted origin does not recover its own lost writes from peers';
const SETTLE_MS = 30_000;

const dataDbDir = (node) => join(node.dataRootDir, 'database', DB);
const ownLogDir = (node) => join(dataDbDir(node), 'transaction_logs', 'local');

async function fileSizes(directory) {
	const sizes = {};
	for (const name of await readdir(directory)) sizes[name] = (await stat(join(directory, name))).size;
	return sizes;
}

async function tableFiles(node) {
	return (await readdir(dataDbDir(node)))
		.filter((name) => name.endsWith('.sst') || name.startsWith('MANIFEST-'))
		.sort();
}

/** rocksdb-js syncs the transaction logs when a memtable flush begins. */
async function flushesStarted(node) {
	let count = 0;
	for (const name of await readdir(dataDbDir(node))) {
		if (name !== 'LOG' && !name.startsWith('LOG.old')) continue;
		const text = await readFile(join(dataDbDir(node), name), 'utf8');
		count += text.split('"event": "flush_started"').length - 1;
	}
	return count;
}

async function upsertConfirmed(node, record) {
	const response = await sendOperation(
		node,
		{ operation: 'upsert', database: DB, table: 'Counter', records: [record], replicatedConfirmation: 1 },
		{ signal: AbortSignal.timeout(30_000) }
	);
	assert.deepEqual(response.upserted_hashes, [record.id], JSON.stringify(response));
}

async function waitForProcessGone(pid) {
	await waitForCondition(
		() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		},
		{ timeoutMs: 30_000, pollMs: 100, description: `process ${pid} to exit` }
	);
}

async function readCounters(node, ids) {
	const values = {};
	for (const id of ids) values[id] = (await counter(node, id, AbortSignal.timeout(10_000)))?.n;
	return values;
}

suite('power loss on the origin: own replicated writes come back from peers', { timeout: 900_000 }, (ctx) => {
	const contexts = [];
	let snapshotDir;
	let nodeA;
	let nodeB;
	let lockKey;
	let simulated = false;
	const baseline = {};

	before(async () => {
		if ((process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb') !== 'rocksdb') return;
		const started = await Promise.allSettled([startNode(ctx.name), startNode(ctx.name)]);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		[nodeA, nodeB] = contexts.map((c) => c.harper);
		await connectMesh([nodeA, nodeB]);
		await bootstrapHomeMap([nodeA, nodeB]);
		await waitForRing([nodeA, nodeB], 2);

		// Durable before the baseline: the old version a lost update leaves behind.
		await upsertConfirmed(nodeA, { id: 'upd', n: 1 });
		lockKey = await keyHomedOn([nodeA, nodeB], nodeB, nodeA, 'locked');
		await waitForCounter([nodeA, nodeB], 'upd', 1);

		let previous;
		await waitForCondition(
			async () => {
				await delay(1000);
				const current = JSON.stringify(await fileSizes(ownLogDir(nodeA)));
				const settled = current === previous;
				previous = current;
				return settled;
			},
			{ timeoutMs: 60_000, description: `A's own transaction log to stop growing` }
		);
		snapshotDir = await mkdtemp(join(tmpdir(), 'harper-power-loss-snapshot-'));
		await cp(ownLogDir(nodeA), join(snapshotDir, 'local'), { recursive: true });
		baseline.logFiles = await fileSizes(join(snapshotDir, 'local'));
		baseline.tableFiles = await tableFiles(nodeA);
		assert.ok((await readdir(dataDbDir(nodeA))).includes('LOG'), 'the flush check reads RocksDB info LOG');
		baseline.flushes = await flushesStarted(nodeA);

		await upsertConfirmed(nodeA, { id: 'ins', n: 1 });
		await upsertConfirmed(nodeA, { id: 'ins', n: 2 });
		await upsertConfirmed(nodeA, { id: 'upd', n: 2 });
		const increment = await call(nodeA, 'LockedIncrement/', { id: lockKey, timeout: 20_000 });
		assert.equal(increment.status, 200, JSON.stringify(increment.body));
		assert.equal(increment.body.n, 1);
		await waitForCounter([nodeB], lockKey, 1);
		assert.deepEqual(await readCounters(nodeB, ['ins', 'upd']), { ins: 2, upd: 2 });
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
		if (snapshotDir) await rm(snapshotDir, { recursive: true, force: true });
	});

	test('simulated power loss leaves A without its last writes while B keeps them', async (t) => {
		if (!nodeA) return t.skip('RocksDB only: LMDB syncs its commits');
		// B goes down first, so A's post-restart state can be read before any peer could repair it.
		await stopNodeProcess(nodeB);
		const pid = await readNodePid(nodeA);
		assert.ok(pid, 'A has a pid file');
		process.kill(pid, 'SIGKILL');
		await waitForProcessGone(pid);

		assert.deepEqual(
			await tableFiles(nodeA),
			baseline.tableFiles,
			'no flush or compaction wrote table files after the baseline'
		);
		assert.equal(
			await flushesStarted(nodeA),
			baseline.flushes,
			'no memtable flush started (and synced the logs) after the baseline'
		);
		const logsAtKill = await fileSizes(ownLogDir(nodeA));
		for (const [name, size] of Object.entries(baseline.logFiles)) {
			assert.ok(name in logsAtKill, `${name} was not purged after the baseline`);
			if (name.endsWith('.txnlog')) assert.ok(logsAtKill[name] >= size, `${name} only grew after the baseline`);
		}
		const grew = Object.keys(logsAtKill).some(
			(name) => name.endsWith('.txnlog') && logsAtKill[name] !== baseline.logFiles[name]
		);
		assert.ok(
			grew,
			`the lost writes are in A's own log: ${JSON.stringify({ baseline: baseline.logFiles, logsAtKill })}`
		);

		await rm(ownLogDir(nodeA), { recursive: true, force: true });
		await cp(join(snapshotDir, 'local'), ownLogDir(nodeA), { recursive: true });

		await restartStoppedNode(contexts[0]);
		nodeA = contexts[0].harper;
		assert.deepEqual(
			await readCounters(nodeA, ['ins', 'upd', lockKey]),
			{ ins: undefined, upd: 1, [lockKey]: 0 },
			'A came back with the pre-baseline state only'
		);

		await restartStoppedNode(contexts[1]);
		nodeB = contexts[1].harper;
		await waitForMesh([nodeA, nodeB]);
		assert.deepEqual(
			await readCounters(nodeB, ['ins', 'upd', lockKey]),
			{ ins: 2, upd: 2, [lockKey]: 1 },
			'B still holds every write it confirmed'
		);
		simulated = true;
	});

	test('a lock taken on A after the restart sees the lost write', { todo: ISSUE }, async (t) => {
		if (!nodeA) return t.skip('RocksDB only');
		assert.ok(simulated, 'runs only after the power-loss simulation test passed');
		// lockKey is homed on B, whose last grant was to A for the write A lost.
		const onABefore = (await counter(nodeA, lockKey))?.n;
		t.diagnostic(`A read ${lockKey}=${onABefore} before the lock`);
		const increment = await call(nodeA, 'LockedIncrement/', { id: lockKey, timeout: 30_000 });
		const onB = await counter(nodeB, lockKey).catch(() => undefined);
		assert.equal(increment.status, 200, `the lock on A was refused: ${JSON.stringify(increment.body)}`);
		assert.equal(
			increment.body.n,
			2,
			`the lock on A answered n=${increment.body.n}: admitted without A's lost increment (expected 2); A read ${onABefore} before the lock, B now reads ${onB?.n}`
		);
	});

	test('A recovers its own writes from B', { todo: ISSUE }, async (t) => {
		if (!nodeA) return t.skip('RocksDB only');
		assert.ok(simulated, 'runs only after the power-loss simulation test passed');
		// B -> A delivers B's own writes, so the stream A's lost writes would need is live.
		await putCounter(nodeB, 'sentinel-from-b', 1);
		await waitForCounter([nodeA], 'sentinel-from-b', 1);
		let onA;
		await waitForCondition(
			async () => {
				onA = await readCounters(nodeA, ['ins', 'upd']);
				return onA.ins === 2 && onA.upd === 2;
			},
			{
				timeoutMs: SETTLE_MS,
				pollMs: 1000,
				description: () => `A to hold B's confirmed ins=2, upd=2; A reads ${JSON.stringify(onA)}`,
			}
		);
	});
});
