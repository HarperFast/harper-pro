/**
 * harper-pro#1348 with harper-pro#1364: a node that loses the unsynced tail of its own log while it is being
 * removed gets those writes back from its peers, and forwards them, before its removal can finish.
 *
 * C is down for the writes A is about to lose, so only B holds them. A is fenced, then loses that tail: the
 * power-loss simulation of powerLossOwnOriginRecovery.test.mjs (A's own log store restored to an idle copy, then
 * a start on a new boot). B returns the writes carrying A's id, which core applies as local writes. A fence left
 * set refuses them, so C never gets them, while C's floor for A still passes the fence target and the removal
 * reports that A's writes reached both peers.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readLog, readNodePid, sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';
import {
	DB,
	bootstrapHomeMap,
	connectMesh,
	counter,
	operation,
	putCounter,
	restartStoppedNode,
	startNode,
	stopNode,
	waitForCounter,
	waitForMesh,
	waitForRing,
} from './recordLockShared.mjs';

// floors reach peers within a second, so the drain does not wait out the 30 s production interval
const FLOORS = { HARPER_TEST_ORIGIN_FLOOR_INTERVAL_MS: '500' };
const FIRST_BOOT = { ...FLOORS, HARPER_TEST_BOOT_ID: 'removal-power-loss-boot-1' };
const SECOND_BOOT = { ...FLOORS, HARPER_TEST_BOOT_ID: 'removal-power-loss-boot-2' };
const RECOVERING = /its peers have yet to return its own writes/;
const FENCED = /being removed from its cluster/;

const dataDbDir = (node) => join(node.dataRootDir, 'database', DB);
const ownLogDir = (node) => join(dataDbDir(node), 'transaction_logs', 'local');

async function fileSizes(directory) {
	const sizes = {};
	for (const name of await readdir(directory)) sizes[name] = (await stat(join(directory, name))).size;
	return sizes;
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

const removeA = (coordinator, target) =>
	operation(coordinator, { operation: 'remove_node', hostname: target.hostname, timeout: 120_000 });

suite('power loss on a node that is being removed', { timeout: 900_000 }, (ctx) => {
	const contexts = [];
	let snapshotDir;
	let reportHoldDir;
	let nodeA;
	let nodeB;
	let nodeC;
	let restarted = false;
	let refused = false;

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

		// durable before the baseline: the old version a lost update leaves behind
		await upsertConfirmed(nodeA, { id: 'upd', n: 1 });
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
		snapshotDir = await mkdtemp(join(tmpdir(), 'harper-removal-power-loss-snapshot-'));
		reportHoldDir = await mkdtemp(join(tmpdir(), 'harper-removal-power-loss-hold-'));
		await cp(ownLogDir(nodeA), join(snapshotDir, 'local'), { recursive: true });
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
		for (const dir of [snapshotDir, reportHoldDir]) if (dir) await rm(dir, { recursive: true, force: true });
	});

	test('a fenced node that lost its last writes takes them back from its peer after the restart', async (t) => {
		if (!nodeA) return t.skip('RocksDB only: LMDB syncs its commits and holds no fence');
		const flushes = await flushesStarted(nodeA);
		// C misses the writes A is about to lose, so B is their only other holder
		await stopNodeProcess(nodeC);
		await upsertConfirmed(nodeA, { id: 'ins', n: 1 });
		await upsertConfirmed(nodeA, { id: 'ins', n: 2 });
		await upsertConfirmed(nodeA, { id: 'upd', n: 2 });
		await waitForCounter([nodeB], 'ins', 2);
		await waitForCounter([nodeB], 'upd', 2);

		const fence = await operation(nodeA, { operation: 'remove_node_fence', node: nodeA.hostname });
		assert.equal(fence.status, 200, JSON.stringify(fence.body));
		assert.equal(fence.body.state, 'fenced');
		assert.match(JSON.stringify(await putCounter(nodeA, 'refused', 1).catch((error) => error.message)), FENCED);

		await stopNodeProcess(nodeB);
		const pid = await readNodePid(nodeA);
		process.kill(pid, 'SIGKILL');
		await waitForProcessGone(pid);
		assert.equal(await flushesStarted(nodeA), flushes, 'no memtable flush started (and synced the logs)');
		await rm(ownLogDir(nodeA), { recursive: true, force: true });
		await cp(join(snapshotDir, 'local'), ownLogDir(nodeA), { recursive: true });

		// reports held: A's recovery stays unconfirmed until the test releases it
		await restartStoppedNode(contexts[0], { ...SECOND_BOOT, HARPER_TEST_HOLD_OWN_ORIGIN_REPORT_DIR: reportHoldDir });
		nodeA = contexts[0].harper;
		assert.equal((await counter(nodeA, 'ins'))?.n, undefined, 'A came back without the writes it lost');
		assert.equal((await counter(nodeA, 'upd'))?.n, 1);
		await restartStoppedNode(contexts[1], FIRST_BOOT);
		nodeB = contexts[1].harper;
		await restartStoppedNode(contexts[2], FIRST_BOOT);
		nodeC = contexts[2].harper;
		await waitForMesh([nodeA, nodeB, nodeC]);

		await waitForCounter([nodeA, nodeB, nodeC], 'ins', 2);
		await waitForCounter([nodeA, nodeB, nodeC], 'upd', 2);
		assert.doesNotMatch(await readLog(nodeA), /Replicated transaction failed/);
		restarted = true;
	});

	test('the removal is refused, and the node accepts writes, while its recovery is unconfirmed', async (t) => {
		if (!nodeA) return t.skip('RocksDB only');
		assert.ok(restarted, 'runs only after the power-loss test passed');
		await waitForCondition(() => existsSync(join(reportHoldDir, 'held')), {
			timeoutMs: 60_000,
			description: `A's recovery report to be parked in ${reportHoldDir}`,
		});
		const removal = await removeA(nodeB, nodeA);
		// B relays the refusal A decided, with A's status
		assert.equal(removal.status, 409, JSON.stringify(removal.body));
		assert.match(JSON.stringify(removal.body), RECOVERING);
		await putCounter(nodeA, 'after', 1);
		await waitForCounter([nodeA, nodeB, nodeC], 'after', 1);
		refused = true;
	});

	test('once its peers have reported, the removal drains it and every peer holds its writes', async (t) => {
		if (!nodeA) return t.skip('RocksDB only');
		assert.ok(refused, 'runs only after the refusal test passed');
		await writeFile(join(reportHoldDir, 'release'), '');
		let removal;
		await waitForCondition(
			async () => {
				removal = await removeA(nodeB, nodeA);
				if (removal.status === 200) return true;
				assert.match(JSON.stringify(removal.body), RECOVERING, `an unexpected refusal: ${JSON.stringify(removal)}`);
				return false;
			},
			{
				timeoutMs: 240_000,
				pollMs: 1000,
				description: () => `the removal to succeed once A's recovery is confirmed: ${JSON.stringify(removal?.body)}`,
			}
		);
		assert.match(removal.body.message, /its writes reached 2 peers/);
		for (const node of [nodeB, nodeC])
			assert.deepEqual(
				{
					ins: (await counter(node, 'ins'))?.n,
					upd: (await counter(node, 'upd'))?.n,
					after: (await counter(node, 'after'))?.n,
				},
				{ ins: 2, upd: 2, after: 1 },
				`${node.hostname} holds every write A took before it was removed`
			);
	});
});
