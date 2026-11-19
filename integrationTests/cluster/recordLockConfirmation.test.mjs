// A leaves replication.recordLockConfirmation unset, so with cluster record locks on its locked commits wait for
// one peer. B's `confirmation: 2` is more than the one peer it replicates to. It still joins the cluster and
// applies A's writes, because the default skips the system database and replication apply.
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
	DB,
	bootstrapHomeMap,
	call,
	connectMesh,
	counter,
	putCounter,
	startNode,
	stopNode,
	waitForCounter,
	waitForRing,
} from './recordLockShared.mjs';
import { readNodePid, sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

// long, so a wait that ends well before it was ended by the peers being gone
const CONFIRMATION_TIMEOUT_MS = 120_000;
// recordLockShared's pingTimeout: how long a sender with no receipt still counts as connected
const PING_TIMEOUT_MS = 3_000;
// holds A's frames to B while the file `pause-<B's address>` exists in A's pause dir; pings are not held
const PAUSE_INJECTOR = join(import.meta.dirname, 'replicationSendPauseInjector.mjs');
const HOLD_MS = 3_000;

suite('replication confirmation defaults', { timeout: 300_000 }, (ctx) => {
	const contexts = [];
	let a, b, bPid, aPauseDir;

	before(async () => {
		aPauseDir = await mkdtemp(join(tmpdir(), 'lock-confirmation-pause-'));
		const started = await Promise.allSettled([
			startNode(ctx.name, { HARPER_TEST_REPLICATION_PAUSE_DIR: aPauseDir }, 1, [PAUSE_INJECTOR], true, [], {
				confirmationTimeout: CONFIRMATION_TIMEOUT_MS,
			}),
			startNode(ctx.name, {}, 1, undefined, true, [], { confirmation: 2 }),
		]);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		[a, b] = contexts.map((c) => c.harper);
		await connectMesh([a, b]);
		await bootstrapHomeMap([a, b]);
		await waitForRing([a, b], 2);
	});

	after(async () => {
		if (bPid) process.kill(bPid, 'SIGCONT');
		for (const c of contexts) await stopNode(c);
		if (aPauseDir) await rm(aPauseDir, { recursive: true, force: true });
	});

	// lock while B is up, so the cluster lock itself does not depend on B
	async function holdGatedWrite(id, n, afterSave = false) {
		let settled = false;
		const writing = call(a, 'GatedLockedWrite/', { id, n, lease: 60_000, timeout: 10_000, afterSave }).finally(() => {
			settled = true;
		});
		await waitForCondition(
			async (signal) => ((await call(a, 'GateControl/', { id }, signal)).body?.waiting ? true : undefined),
			{ timeoutMs: 30_000, description: `the gated write of ${id} to hold its cluster lock` }
		);
		return { writing, settled: () => settled };
	}

	test('a write default no peer set can meet is refused before the write lands, and an explicit 0 overrides it', async () => {
		const refused = await fetch(`${b.httpURL}/Counter/default-refused`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: 'default-refused', n: 1 }),
		});
		const refusal = await refused.text();
		assert.equal(refused.status, 400, refusal);
		assert.match(refusal, /Cannot confirm replication to more nodes \(2\)/);
		assert.equal(await counter(b, 'default-refused'), undefined);

		const overridden = await fetch(`${b.httpURL}/Counter/default-overridden`, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Basic ' + Buffer.from(`${b.admin.username}:${b.admin.password}`).toString('base64'),
				'X-Replicate-To': '*;confirm=0',
			},
			body: JSON.stringify({ id: 'default-overridden', n: 2 }),
		});
		assert.ok(overridden.ok, `${overridden.status} ${await overridden.text()}`);
		await waitForCounter([a, b], 'default-overridden', 2);
	});

	test('with the key unset, a locked commit answers once the peer has the write', async () => {
		const result = await call(a, 'LockedIncrement/', { id: 'locked-confirmed' });
		assert.equal(result.status, 200, JSON.stringify(result.body));
		assert.equal((await counter(b, 'locked-confirmed'))?.n, 1);
	});

	async function counterLog(node, signal) {
		const response = await fetch(`${node.httpURL}/CounterLog/`, { headers: { Accept: 'application/json' }, signal });
		const text = await response.text();
		assert.equal(response.status, 200, text);
		return JSON.parse(text).filter((entry) => !entry.type.startsWith('lock'));
	}

	test('a locked commit logged after a later-keyed write B already acknowledged waits until B applies it (harper-pro#1391)', async () => {
		const id = 'locked-out-of-order';
		const gated = await holdGatedWrite(id, 3, true);
		const pauseFile = join(aPauseDir, `pause-${b.hostname}`);
		try {
			// the operations API runs on the main thread, so this commits while the gated transaction is open
			await sendOperation(a, {
				operation: 'upsert',
				database: DB,
				table: 'Counter',
				records: [{ id: 'logged-first', n: 1 }],
				replicatedConfirmation: 1,
			});
			assert.equal((await counter(b, 'logged-first'))?.n, 1, 'B applied the later-keyed write');
			// B sends its key acknowledgment 2 ms after the marker acknowledgment the upsert returned on; let it land, so a
			// waiter seeded from B's key maximum would be seeded as confirmed
			await delay(200);
			await writeFile(pauseFile, '');
			assert.equal((await call(a, 'GateControl/', { id, open: true })).body.waiting, true);
			await waitForCondition(
				async (signal) => ((await counterLog(a, signal)).some((entry) => entry.id === id) ? true : undefined),
				{ timeoutMs: 10_000, description: 'the gated write to commit on A' }
			);
			await delay(HOLD_MS);
			assert.equal(gated.settled(), false, 'confirmed while its frame was held back from B');
			assert.equal(await counter(b, id), undefined, 'B has not received the held frame');
		} finally {
			await rm(pauseFile, { force: true });
			await call(a, 'GateControl/', { id, open: true }).catch(() => {});
			await gated.writing.catch(() => {});
		}

		const result = await gated.writing;
		assert.equal(result.status, 200, JSON.stringify(result.body));
		assert.equal((await counter(b, id))?.n, 3, 'confirmed once B applied it');
		const log = await counterLog(a);
		const loggedFirst = log.findIndex((entry) => entry.id === 'logged-first');
		const held = log.findIndex((entry) => entry.id === id);
		assert.ok(
			loggedFirst >= 0 && loggedFirst < held && log[held].key < log[loggedFirst].key,
			`the gated write reached A's log after a later-keyed write: ${JSON.stringify(log)}`
		);
	});

	test('when the peer stops answering mid-wait, the locked commit fails as unconfirmed well before confirmationTimeout', async () => {
		const id = 'locked-unconfirmed';
		const gated = await holdGatedWrite(id, 5);
		bPid = await readNodePid(b);
		process.kill(bPid, 'SIGSTOP');
		const opened = performance.now();
		// A's sender to B is still fresh, so the commit passes the connected-peer check and starts waiting
		assert.equal((await call(a, 'GateControl/', { id, open: true })).body.waiting, true);
		await waitForCondition(async (signal) => ((await counter(a, id, signal))?.n === 5 ? true : undefined), {
			timeoutMs: 10_000,
			description: 'the locked write to commit locally',
		});
		// the native key goes back at local commit; a cluster-scoped lock() here would also depend on paused B
		assert.equal((await call(a, 'LockOnce/', { id, scope: 'node', timeout: 2_000 })).status, 200);
		assert.equal(gated.settled(), false, 'the locked write was still waiting for confirmation');
		const result = await gated.writing;
		const elapsed = performance.now() - opened;

		assert.equal(result.status, 504, JSON.stringify(result.body));
		assert.equal(result.body.replicationUnconfirmed, true, JSON.stringify(result.body));
		assert.equal(result.body.retryable, false, JSON.stringify(result.body));
		assert.match(JSON.stringify(result.body), /The write committed on this node but was not confirmed/);
		assert.ok(elapsed < CONFIRMATION_TIMEOUT_MS / 4, `answered after ${elapsed}ms`);
		assert.equal((await counter(a, id))?.n, 5, 'the write committed locally');

		process.kill(bPid, 'SIGCONT');
		bPid = undefined;
		await waitForCondition(
			async (signal) =>
				(await call(a, 'LockedIncrement/', { id: 'locked-after-resume' }, signal)).status === 200 ? true : undefined,
			{ timeoutMs: 60_000, description: 'locked commits to confirm again once B resumes' }
		);
	});

	test('with the peer stopped, a locked commit is refused before it commits and the key is free', async () => {
		const id = 'locked-refused';
		const gated = await holdGatedWrite(id, 7);
		await stopNodeProcess(b);
		// past the sender liveness window, whether or not A saw B's sockets close
		await delay(PING_TIMEOUT_MS + 500);
		const opened = performance.now();
		assert.equal((await call(a, 'GateControl/', { id, open: true })).body.waiting, true);
		const result = await gated.writing;
		const elapsed = performance.now() - opened;

		assert.equal(result.status, 503, JSON.stringify(result.body));
		assert.match(JSON.stringify(result.body), /Cannot commit a write made under a cluster record lock/);
		assert.match(JSON.stringify(result.body), /recordLockConfirmation/);
		assert.ok(elapsed < 5_000, `answered after ${elapsed}ms`);
		assert.equal(await counter(a, id), undefined, 'nothing was committed');
		assert.equal((await call(a, 'LockOnce/', { id, scope: 'node', timeout: 2_000 })).status, 200);

		const started = performance.now();
		await putCounter(a, 'unlocked-while-peer-down', 1);
		assert.ok(performance.now() - started < 5_000, 'an unlocked write did not wait');
	});
});
