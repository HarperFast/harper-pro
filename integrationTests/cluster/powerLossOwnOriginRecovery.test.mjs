/**
 * harper-pro#1364: a RocksDB node that loses the unsynced tail of its own transaction log (power loss)
 * after those writes replicated gets them back from its peers, and record locks on it wait for that.
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
 * The tests run in the order the node meets them: a lock right after the reconnect, then convergence
 * within a bounded wait. A restarts with its recovery reports held (`HARPER_TEST_HOLD_OWN_ORIGIN_REPORT_DIR`),
 * so the lock first meets a recovery that is not yet confirmed and must refuse, whatever the rows read.
 *
 * A third node, C, is down for the lost writes, so after the power loss only B holds them. A lock on C needs
 * a barrier from A, which A refuses until every peer has reported (`executeBarrier` in recordLockRpc.ts): a
 * barrier written before then could follow a log still missing writes. With every home reachable, C's
 * refusal can come only from that guard, so the test fails with it removed. The held report parks after the
 * returned rows apply, and A forwards them to C, so C's state is not asserted while the report is held.
 *
 * Recovery runs only when the OS may have dropped page-cache data, so each start names its boot through
 * `HARPER_TEST_BOOT_ID`: the power loss restarts A on a new boot, and the last tests restart A's process on
 * the same boot, once plainly and once after a recorded transaction-log sync failure.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

const SETTLE_MS = 30_000;
const FIRST_BOOT = { HARPER_TEST_BOOT_ID: 'power-loss-boot-1' };
const SECOND_BOOT = { HARPER_TEST_BOOT_ID: 'power-loss-boot-2' };
const SYNC_FAILURE_MARKER = 'own-origin-recovery-log-sync-failed';
const BARRIER_REFUSAL = /cannot yet vouch for its own writes/;

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
	let reportHoldDir;
	let nodeA;
	let nodeB;
	let nodeC;
	let lockKey;
	let simulated = false;
	let recovered = false;
	const extraHoldDirs = [];
	const baseline = {};

	before(async () => {
		if ((process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb') !== 'rocksdb') return;
		const started = await Promise.allSettled([
			startNode(ctx.name, FIRST_BOOT),
			startNode(ctx.name, FIRST_BOOT),
			startNode(ctx.name, FIRST_BOOT),
		]);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		[nodeA, nodeB, nodeC] = contexts.map((c) => c.harper);
		await connectMesh([nodeA, nodeB, nodeC]);
		await bootstrapHomeMap([nodeA, nodeB, nodeC]);
		await waitForRing([nodeA, nodeB, nodeC], 3);

		// Durable before the baseline: the old version a lost update leaves behind.
		await upsertConfirmed(nodeA, { id: 'upd', n: 1 });
		lockKey = await keyHomedOn([nodeA, nodeB, nodeC], nodeB, nodeA, 'locked');
		await waitForCounter([nodeA, nodeB, nodeC], 'upd', 1);

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
		reportHoldDir = await mkdtemp(join(tmpdir(), 'harper-power-loss-report-hold-'));
		await cp(ownLogDir(nodeA), join(snapshotDir, 'local'), { recursive: true });
		baseline.logFiles = await fileSizes(join(snapshotDir, 'local'));
		baseline.tableFiles = await tableFiles(nodeA);
		assert.ok((await readdir(dataDbDir(nodeA))).includes('LOG'), 'the flush check reads RocksDB info LOG');
		baseline.flushes = await flushesStarted(nodeA);

		// C misses the writes A is about to lose, so B is their only other holder.
		await stopNodeProcess(nodeC);
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
		for (const dir of [snapshotDir, reportHoldDir, ...extraHoldDirs])
			if (dir) await rm(dir, { recursive: true, force: true });
	});

	/** Kill A's process with its page cache intact (the OS stays up) and start it again with reports held. */
	async function crashAndRestartA(env) {
		const holdDir = await mkdtemp(join(tmpdir(), 'harper-power-loss-report-hold-'));
		extraHoldDirs.push(holdDir);
		const pid = await readNodePid(nodeA);
		process.kill(pid, 'SIGKILL');
		await waitForProcessGone(pid);
		if (env.beforeStart) await env.beforeStart();
		await restartStoppedNode(contexts[0], { ...env.boot, HARPER_TEST_HOLD_OWN_ORIGIN_REPORT_DIR: holdDir });
		nodeA = contexts[0].harper;
		await waitForMesh([nodeA, nodeB, nodeC]);
		return holdDir;
	}

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

		await restartStoppedNode(contexts[0], { ...SECOND_BOOT, HARPER_TEST_HOLD_OWN_ORIGIN_REPORT_DIR: reportHoldDir });
		nodeA = contexts[0].harper;
		assert.deepEqual(
			await readCounters(nodeA, ['ins', 'upd', lockKey]),
			{ ins: undefined, upd: 1, [lockKey]: 0 },
			'A came back with the pre-baseline state only'
		);

		await restartStoppedNode(contexts[1], FIRST_BOOT);
		nodeB = contexts[1].harper;
		await restartStoppedNode(contexts[2], FIRST_BOOT);
		nodeC = contexts[2].harper;
		await waitForMesh([nodeA, nodeB, nodeC]);
		assert.deepEqual(
			await readCounters(nodeB, ['ins', 'upd', lockKey]),
			{ ins: 2, upd: 2, [lockKey]: 1 },
			'B still holds every write it confirmed'
		);
		simulated = true;
	});

	test('a lock taken on A after the restart waits for its recovery and sees the lost write', async (t) => {
		if (!nodeA) return t.skip('RocksDB only');
		assert.ok(simulated, 'runs only after the power-loss simulation test passed');
		await waitForCondition(() => existsSync(join(reportHoldDir, 'held')), {
			timeoutMs: 60_000,
			description: `B to return A's writes (A's report parked in ${reportHoldDir})`,
		});
		// lockKey is homed on B, whose last grant was to A for the write A lost.
		const refused = await call(nodeA, 'LockedIncrement/', { id: lockKey, timeout: 3_000 });
		assert.equal(
			refused.status,
			503,
			`a lock admitted before A's recovery was confirmed: ${JSON.stringify(refused.body)}`
		);
		assert.match(JSON.stringify(refused.body), /successor freshness/);
		// C's lock (B, the key's home, is up) and B's own need A's lineage through a barrier A writes, which A
		// refuses until its writes are back
		for (const [name, node] of [
			['C', nodeC],
			['B', nodeB],
		]) {
			const refusedThere = await call(node, 'LockedIncrement/', { id: lockKey, timeout: 3_000 });
			assert.equal(
				refusedThere.status,
				503,
				`a lock on ${name} was admitted before A's recovery was confirmed: ${JSON.stringify(refusedThere.body)}`
			);
			assert.match(JSON.stringify(refusedThere.body), BARRIER_REFUSAL, `${name}'s refusal came from A's barrier guard`);
		}
		await writeFile(join(reportHoldDir, 'release'), '');
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
		const onC = await call(nodeC, 'LockedIncrement/', { id: lockKey, timeout: 30_000 });
		assert.equal(onC.status, 200, `the lock on C was refused after A recovered: ${JSON.stringify(onC.body)}`);
		assert.equal(onC.body.n, 3, `C's first lock after A recovered answered n=${onC.body.n} (expected 3)`);
		// A takes the key back, so the restart tests below depend on A's own lineage
		const again = await call(nodeA, 'LockedIncrement/', { id: lockKey, timeout: 30_000 });
		assert.equal(again.status, 200, `the lock on A was refused after C's: ${JSON.stringify(again.body)}`);
		assert.equal(again.body.n, 4);
	});

	test('A recovers its own writes from B', async (t) => {
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
		recovered = true;
	});

	test('a process restart on the same boot keeps the recovery done and admits own lineage at once', async (t) => {
		if (!nodeA) return t.skip('RocksDB only');
		assert.ok(recovered, 'runs only after A recovered');
		const holdDir = await crashAndRestartA({ boot: SECOND_BOOT });
		// lockKey's last grant was A's n=4, minted on this boot: a new epoch would hold it behind the parked report
		const increment = await call(nodeA, 'LockedIncrement/', { id: lockKey, timeout: 10_000 });
		assert.equal(increment.status, 200, `the lock on A waited for a recovery: ${JSON.stringify(increment.body)}`);
		assert.equal(increment.body.n, 5);
		// a sentinel from B proves the subscription exchange that would carry a recovery range has run
		await putCounter(nodeB, 'sentinel-after-crash', 1);
		await waitForCounter([nodeA], 'sentinel-after-crash', 1);
		await waitForCounter([nodeB], lockKey, 5);
		assert.equal(existsSync(join(holdDir, 'held')), false, 'A asked a peer for its own writes after a process restart');
	});

	test('a recorded transaction-log sync failure makes the next start on the same boot recover', async (t) => {
		if (!nodeA) return t.skip('RocksDB only');
		assert.ok(recovered, 'runs only after A recovered');
		const marker = join(nodeA.dataRootDir, SYNC_FAILURE_MARKER);
		const holdDir = await crashAndRestartA({
			boot: SECOND_BOOT,
			beforeStart: () => writeFile(marker, 'injected-sync-failure'),
		});
		await waitForCondition(() => existsSync(join(holdDir, 'held')), {
			timeoutMs: 60_000,
			description: `B to return A's writes after the recorded sync failure (A's report parked in ${holdDir})`,
		});
		assert.equal(existsSync(marker), false, 'the marker is cleared once the recovery epoch is durable');
		const refused = await call(nodeA, 'LockedIncrement/', { id: lockKey, timeout: 3_000 });
		assert.equal(
			refused.status,
			503,
			`a lock admitted before A's recovery was confirmed: ${JSON.stringify(refused.body)}`
		);
		await writeFile(join(holdDir, 'release'), '');
		const increment = await call(nodeA, 'LockedIncrement/', { id: lockKey, timeout: 30_000 });
		assert.equal(increment.status, 200, `the lock on A was refused: ${JSON.stringify(increment.body)}`);
		assert.equal(increment.body.n, 6);
	});
});
