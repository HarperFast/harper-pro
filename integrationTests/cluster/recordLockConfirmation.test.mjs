// B's `confirmation: 2` is more than the one peer it replicates to. It still joins the cluster and applies
// A's writes, because the default skips the system database and replication apply.
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
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
import { stopNodeProcess, waitForCondition } from './clusterShared.mjs';

const CONFIRMATION_TIMEOUT_MS = 4_000;

suite('replication confirmation defaults', { timeout: 300_000 }, (ctx) => {
	const contexts = [];
	let a, b;

	before(async () => {
		const started = await Promise.allSettled([
			startNode(ctx.name, {}, 1, undefined, true, {
				recordLockConfirmation: 1,
				confirmationTimeout: CONFIRMATION_TIMEOUT_MS,
			}),
			startNode(ctx.name, {}, 1, undefined, true, { confirmation: 2, confirmationTimeout: CONFIRMATION_TIMEOUT_MS }),
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
		for (const c of contexts) await stopNode(c);
	});

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

	test('a locked commit answers once the peer has the write', async () => {
		const result = await call(a, 'LockedIncrement/', { id: 'locked-confirmed' });
		assert.equal(result.status, 200, JSON.stringify(result.body));
		assert.equal((await counter(b, 'locked-confirmed'))?.n, 1);
	});

	test('with the peer stopped, a locked commit fails as unconfirmed after confirmationTimeout and releases the lock', async () => {
		const id = 'locked-unconfirmed';
		let settled = false;
		const writing = call(a, 'GatedLockedWrite/', { id, n: 5, lease: 60_000, timeout: 10_000 }).finally(() => {
			settled = true;
		});
		await waitForCondition(
			async (signal) => ((await call(a, 'GateControl/', { id }, signal)).body?.waiting ? true : undefined),
			{
				timeoutMs: 30_000,
				description: 'the gated write to hold its cluster lock',
			}
		);
		await stopNodeProcess(b);
		const opened = performance.now();
		assert.equal((await call(a, 'GateControl/', { id, open: true })).body.waiting, true);
		await waitForCondition(async (signal) => ((await counter(a, id, signal))?.n === 5 ? true : undefined), {
			timeoutMs: CONFIRMATION_TIMEOUT_MS,
			description: 'the locked write to commit locally',
		});
		// The native key goes back at local commit, before the confirmation wait ends. A cluster-scoped lock()
		// here can depend on B, which is stopped (it answered 504 in CI).
		assert.equal((await call(a, 'LockOnce/', { id, scope: 'node', timeout: 2_000 })).status, 200);
		assert.equal(settled, false, 'the locked write was still waiting for confirmation');
		const result = await writing;
		const elapsed = performance.now() - opened;

		assert.equal(result.status, 504, JSON.stringify(result.body));
		assert.equal(result.body.replicationUnconfirmed, true, JSON.stringify(result.body));
		assert.equal(result.body.retryable, false, JSON.stringify(result.body));
		assert.ok(elapsed >= CONFIRMATION_TIMEOUT_MS - 500, `answered after ${elapsed}ms`);
		assert.equal((await counter(a, id))?.n, 5, 'the write committed locally');

		const started = performance.now();
		await putCounter(a, 'unlocked-while-peer-down', 1);
		assert.ok(performance.now() - started < CONFIRMATION_TIMEOUT_MS, 'an unlocked write did not wait');
	});
});
