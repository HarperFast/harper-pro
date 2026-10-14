/**
 * The record-lock fixture on nodes with two http workers, whose holds live in one worker's memory:
 * a lock taken and released in one request does not depend on the serving worker, and a release
 * served by a worker that does not hold the token answers 409 instead of leaving the hold to its lease.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import {
	assertLocks,
	bootstrapHomeMap,
	call,
	connectMesh,
	lockStatus,
	startNode,
	stopNode,
	waitForRing,
} from './recordLockShared.mjs';

const THREADS = 2;

/** POST on a connection of its own: a pooled keep-alive connection stays on one worker. */
function callFresh(node, path, body) {
	return new Promise((resolve, reject) => {
		const req = request(
			`${node.httpURL}/${path}`,
			{
				method: 'POST',
				agent: false,
				signal: AbortSignal.timeout(30_000),
				headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			},
			(response) => {
				let text = '';
				response.setEncoding('utf8');
				response.on('data', (chunk) => (text += chunk));
				response.on('end', () => {
					let parsed;
					try {
						parsed = JSON.parse(text);
					} catch {
						parsed = text;
					}
					resolve({ status: response.statusCode, body: parsed });
				});
				response.on('error', reject);
			}
		);
		req.on('error', reject);
		req.end(JSON.stringify(body));
	});
}

suite(`cluster record locks: the fixture at threads.count ${THREADS}`, { timeout: 420_000 }, (ctx) => {
	const contexts = [];
	let nodes;

	before(async () => {
		const started = await Promise.allSettled([startNode(ctx.name, {}, THREADS), startNode(ctx.name, {}, THREADS)]);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		nodes = contexts.map((c) => c.harper);
		await connectMesh(nodes);
		await bootstrapHomeMap(nodes);
		await waitForRing(nodes, nodes.length);
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
	});

	test('a lock taken and released in one request is admitted on every node, on whichever worker serves it', async () => {
		for (let round = 0; round < 5; round++) await assertLocks(nodes, 200, `round ${round}`);
		// The same key passes node to node, each worker serving it in turn. A fresh connection per request
		// spreads them over the workers; keep going until each node has served from both.
		const served = new Map(nodes.map((node) => [node, new Set()]));
		for (let round = 0; round < 40 && [...served.values()].some((threads) => threads.size < THREADS); round++) {
			const id = `once-${Date.now()}-${round}`;
			for (const node of nodes) {
				const locked = await callFresh(node, 'LockOnce/', { id, timeout: 2_000 });
				assert.equal(locked.status, 200, `${node.hostname} round ${round}: ${JSON.stringify(locked.body)}`);
				served.get(node).add(locked.body.threadId);
			}
		}
		for (const [node, threads] of served)
			assert.equal(threads.size, THREADS, `${node.hostname} was served by workers ${[...threads]} only`);
	});

	test('a release is honored by the worker that holds the lock and refused with 409 by the other', async () => {
		const [holder, successor] = nodes;
		const tokens = new Set();
		let refused = 0;
		// Three rounds for token uniqueness, then on until a release has been refused once.
		for (let round = 0; round < 40 && (round < 3 || refused === 0); round++) {
			const id = `hold-${Date.now()}-${round}`;
			const held = await callFresh(holder, 'LockHold/', { id, lease: 30_000, timeout: 5_000 });
			assert.equal(held.status, 200, JSON.stringify(held.body));
			const { token, threadId } = held.body;
			assert.ok(token.startsWith(`${threadId}:`), `token ${token} does not name the worker ${threadId} that holds it`);
			assert.ok(!tokens.has(token), `token ${token} was issued twice`);
			tokens.add(token);
			let released;
			for (let attempt = 0; attempt < 40 && released?.status !== 200; attempt++) {
				released = await callFresh(holder, 'LockRelease/', { token });
				if (released.status !== 409) continue;
				refused++;
				if (refused === 1) {
					const contended = await call(successor, 'LockOnce/', { id, timeout: 300 });
					assert.equal(
						contended.status,
						423,
						`a refused release must leave the lock held: ${JSON.stringify(contended.body)}`
					);
				}
			}
			assert.equal(
				released.status,
				200,
				`40 releases never reached worker ${threadId}: ${JSON.stringify(released.body)}`
			);
			assert.equal(released.body.threadId, threadId);
			// The lease is 30 s and this lock waits 2 s: admitted only if the release really freed the key.
			assert.equal(
				await lockStatus(successor, id),
				200,
				`${successor.hostname} was not admitted after the release of ${token}`
			);
		}
		assert.ok(refused > 0, 'no release reached the worker that does not hold the lock, so the 409 path went untested');
	});
});
