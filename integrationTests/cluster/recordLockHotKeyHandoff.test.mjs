/**
 * A hot key's waiters are served by the release, not by their own deadline: a waiter that fails 423 or 503
 * at its deadline has been told nothing about the record.
 *
 * Loopback hides the defect. A freshness barrier takes at least 1.5 round trips and a recall arrives within
 * one contender poll (25 ms) plus a hop, so the preloaded injector supplies the round trip, and each round
 * first hands the key across every node, so its lineage names them all and every later grant needs a barrier.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
	DB,
	bootstrapHomeMap,
	call,
	clusterStatusOf,
	connectMesh,
	putCounter,
	startNode,
	stopNode,
	waitForCounter,
	waitForRing,
} from './recordLockShared.mjs';

const ONE_WAY_LATENCY_MS = 20;
const REVISIONS = 30;
const WORK_MS = 10;
const ROUNDS = 3;
/** Half of `DEFAULT_LOCK_TIMEOUT_MS` (30 s), which these locks wait under. */
const WAITER_BOUND_MS = 15_000;
const REQUEST_BOUND_MS = 45_000;
const poolOff = JSON.parse(process.env.HARPER_CONFIG ?? '{}').replication?.threads <= 0;

function summarize(outcomes) {
	const byStatus = {};
	for (const { status } of outcomes) byStatus[status] = (byStatus[status] ?? 0) + 1;
	return { byStatus, slowestMs: Math.round(Math.max(...outcomes.map(({ elapsedMs }) => elapsedMs))) };
}

async function reviseConcurrently(nodes, id) {
	const attempt = async (index) => {
		const startedAt = performance.now();
		const { status, body } = await call(
			nodes[index % nodes.length],
			'LockedRevision/',
			{ id, ifMatch: 0, revision: index + 1, workMs: WORK_MS },
			AbortSignal.timeout(REQUEST_BOUND_MS)
		);
		return { index, status, body, elapsedMs: performance.now() - startedAt };
	};
	const indexes = Array.from({ length: REVISIONS }, (_, index) => index);
	const first = indexes.filter((index) => index % nodes.length === 0).map(attempt);
	await delay(5);
	const rest = indexes.filter((index) => index % nodes.length !== 0).map(attempt);
	return Promise.all([...first, ...rest]);
}

async function lockTotals(nodes) {
	const totals = { barriersApplied: 0, relayedAdmissions: 0 };
	for (const node of nodes) {
		let locks;
		for (let attempt = 0; attempt < 5; attempt++) {
			locks = (await clusterStatusOf(node, AbortSignal.timeout(REQUEST_BOUND_MS))).recordLocks?.[DB];
			if (Array.isArray(locks?.poisoned)) break;
			await delay(100);
		}
		assert.ok(Array.isArray(locks?.poisoned), `${node.hostname} coordinating worker did not answer cluster_status`);
		totals.barriersApplied += locks.freshness?.applied ?? 0;
		totals.relayedAdmissions += locks.relayedAdmissions ?? 0;
		assert.deepEqual(locks.poisoned, [], `${node.hostname} reports a replication hole`);
	}
	return totals;
}

function hotKeySuite(name, threadsCount) {
	suite(name, { timeout: 600_000 }, (ctx) => {
		const contexts = [];
		let nodes;
		let markerDir;

		before(async () => {
			markerDir = await mkdtemp(join(tmpdir(), 'latency-'));
			const markers = Array.from({ length: 3 }, (_, index) => join(markerDir, String(index)));
			const started = await Promise.allSettled(
				markers.map((marker) =>
					startNode(
						ctx.name,
						{
							HARPER_TEST_REPLICATION_LATENCY_MS: String(ONE_WAY_LATENCY_MS),
							HARPER_TEST_REPLICATION_LATENCY_MARKER: marker,
						},
						threadsCount,
						[join(import.meta.dirname, 'replicationLatencyInjector.mjs')]
					)
				)
			);
			for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
			const failed = started.find((result) => result.status === 'rejected');
			if (failed) throw failed.reason;
			nodes = contexts.map((c) => c.harper);
			await connectMesh(nodes);
			assert.deepEqual(
				markers.filter((marker) => !existsSync(marker)),
				[],
				'replication frames did not go through the latency injector'
			);
			await bootstrapHomeMap(nodes);
			await waitForRing(nodes, nodes.length);
		});

		after(async () => {
			for (const c of contexts) await stopNode(c);
			if (markerDir) await rm(markerDir, { recursive: true, force: true });
		});

		for (let round = 1; round <= ROUNDS; round++) {
			test(`round ${round}: one revision commits and every waiter gets 412 well inside its wait`, async (t) => {
				const id = `hot-${round}-${Date.now()}`;
				await putCounter(nodes[0], id, 0);
				await waitForCounter(nodes, id, 0);
				for (const node of nodes) {
					const warmed = await call(node, 'LockOnce/', { id }, AbortSignal.timeout(REQUEST_BOUND_MS));
					assert.equal(warmed.status, 200, JSON.stringify(warmed.body));
				}

				const before = await lockTotals(nodes);
				const outcomes = await reviseConcurrently(nodes, id);
				const after = await lockTotals(nodes);
				const barriers = after.barriersApplied - before.barriersApplied;
				const summary = JSON.stringify({ ...summarize(outcomes), barriers });
				t.diagnostic(summary);

				const committed = outcomes.filter(({ status }) => status === 200);
				assert.equal(committed.length, 1, `exactly one revision commits: ${summary}`);
				assert.deepEqual(
					outcomes.filter(({ status }) => status !== 200 && status !== 412),
					[],
					`every waiter acquires after the winner and sees its revision: ${summary}`
				);
				assert.deepEqual(
					outcomes.filter(({ elapsedMs }) => elapsedMs >= WAITER_BOUND_MS),
					[],
					`every waiter resolves within ${WAITER_BOUND_MS} ms: ${summary}`
				);
				// A grant serves a waiter, and proves freshness from at most every other node; allow 2x slack
				// against a rare grace/retry handoff (the stalled livelock produced 6x or more of (n - 1) * REVISIONS).
				assert.ok(barriers >= 1, `the handoffs crossed nodes without a barrier: ${summary}`);
				assert.ok(barriers <= 2 * (nodes.length - 1) * REVISIONS, `grants were lost to recalls: ${summary}`);
				// With the pool on every http worker relays; off it, a client can stay pinned to the coordinating worker.
				if (threadsCount > 1 && !poolOff)
					assert.ok(
						after.relayedAdmissions > before.relayedAdmissions,
						`no non-owner worker served a lock: ${summary}`
					);
				await waitForCounter(nodes, id, committed[0].body.n);
			});
		}
	});
}

hotKeySuite('cluster record locks: a hot key hands over at release', 1);
hotKeySuite('cluster record locks: a hot key hands over at release, across workers', 2);
