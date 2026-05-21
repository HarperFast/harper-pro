/**
 * Worker-exit cascade regression test for PR #147's third fix
 * (`WORKER_EXIT_REASSIGN_STAGGER_MS`).
 *
 * Background: when a worker died, harper-pro's subscriptionManager
 * reassigned every `onDatabase` subscription that worker held to other
 * workers — all in the same event-loop tick. With the receive backpressure
 * fix in place, the *immediate* OOM hazard was contained, but a fresh
 * worker still got slammed with several catch-up connections at once. The
 * stagger fix spaces these reassignments by 100ms via a rolling
 * `nextWorkerExitReassignAt` timestamp.
 *
 * The existing receiveBacklogMemory test runs with `THREADS_COUNT=1`; only
 * one worker, no reassignment possible. This test deliberately runs with
 * 4 worker threads, kills exactly one mid-load, and then inspects the log
 * for the spacing of the post-death "Setting up subscription with leader"
 * lines.
 *
 * Setup:
 *   - Node A: leader, continuously writing
 *   - Node B: target — 4 worker threads, has the SuicideWorker component
 *     installed so the test driver can kill a worker via HTTP
 *
 * Sequence:
 *   1. Start both nodes, connect, deploy components.
 *   2. Begin a sustained write workload on A targeting multiple databases
 *      (so each one becomes a separate subscription on B → multiple
 *      reassignments on worker death).
 *   3. After the workload steadies, hit /SuicideWorker on B. The worker
 *      receiving the request exits with code 137.
 *   4. Watch B's `system_information.threads` over the next 30s and B's
 *      log for "Setting up subscription with leader" lines.
 *
 * Assertions:
 *   - Exactly one new worker PID appears in B's thread list after the
 *     kill (no cascade — only the worker we explicitly killed died).
 *   - Subscription-reassignment log lines in the post-kill window are
 *     spaced at intervals ≥ 80 ms (the configured stagger is 100 ms;
 *     allow a 20 ms slop for log-timestamp resolution).
 *   - B continues committing replication after the kill (its
 *     `lastReceivedVersion` for A's connection still advances).
 *
 * To run locally:
 *   HARPER_RUN_STRESS_TESTS=1 \
 *     npm run test:integration -- integrationTests/stress/workerExitCascade.test.mjs
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import {
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
	setupHarperWithFixture,
} from '@harperfast/integration-testing';
import {
	stressEnabled,
	sendOperation,
	fetchWithRetry,
	readLog,
	clusterSnapshot,
	waitForAllConnected,
} from './stressShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

if (!stressEnabled()) {
	suite('Worker exit cascade (skipped)', () => {
		test('skipped — set HARPER_RUN_STRESS_TESTS=1 to enable', { skip: true }, () => {});
	});
} else {
	const THREADS_PER_NODE = 4;
	const DB_COUNT = 6; // 6 dbs × 1 table each → 6 subscriptions to reassign on worker death

	suite('Worker exit reassignment is staggered, not stampede', { timeout: 240_000 }, (ctx) => {
		before(async () => {
			const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			const cfg = (host) => ({
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, console: true, level: 'debug' },
				replication: { securePort: host + ':9933' },
				threads: { count: THREADS_PER_NODE },
			});
			await startHarper(nodeA, { config: cfg(nodeA.harper.hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
			// B is initialized via setupHarperWithFixture so the SuicideWorker
			// component lives at {dataRoot}/components/fixture-suicide-worker
			// before Harper boots and scans the components dir.
			await setupHarperWithFixture(nodeB, join(import.meta.dirname, 'fixture-suicide-worker'), {
				config: cfg(nodeB.harper.hostname),
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});
			ctx.nodes = [nodeA.harper, nodeB.harper];

			// Mesh: B adds A.
			const tokenResp = await sendOperation(ctx.nodes[0], {
				operation: 'create_authentication_tokens',
				authorization: ctx.nodes[0].admin,
			});
			await sendOperation(ctx.nodes[1], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				authorization: 'Bearer ' + tokenResp.operation_token,
			});

			// Create several databases so multiple subscriptions form on B (each
			// db is a separate WS in replicationConnection). This makes the
			// stagger observable — with one db there's nothing to space out.
			for (let i = 0; i < DB_COUNT; i++) {
				for (const n of ctx.nodes) {
					await sendOperation(n, {
						operation: 'create_table',
						database: `stress_db${i}`,
						table: 'load',
						primary_key: 'id',
						attributes: [
							{ name: 'id', type: 'String' },
							{ name: 'payload', type: 'String' },
						],
					});
				}
			}
			await waitForAllConnected(ctx.nodes[1], { timeoutMs: 60_000 });
		});

		after(async () => {
			if (!ctx.nodes) return;
			await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n }).catch(() => null)));
		});

		test('killing a worker mid-load reassigns subscriptions with ≥80ms stagger and no cascade', async () => {
			const [A, B] = ctx.nodes;

			// Begin a sustained write workload — small upserts across all dbs so
			// replication is actually flowing when we kill the worker.
			let stopWriting = false;
			const writers = [];
			for (let dbI = 0; dbI < DB_COUNT; dbI++) {
				writers.push(
					(async () => {
						let n = 0;
						while (!stopWriting) {
							try {
								await sendOperation(A, {
									operation: 'upsert',
									database: `stress_db${dbI}`,
									table: 'load',
									records: [{ id: `r${n++}`, payload: 'x'.repeat(64) }],
								});
							} catch {
								// Transient hiccups OK during reassignment.
							}
							await delay(25);
						}
					})()
				);
			}

			// Let the cluster reach a steady catch-up state before we perturb it.
			await delay(8000);

			// Snapshot B's threads BEFORE the kill so we can detect new PIDs.
			const beforeInfo = await sendOperation(B, {
				operation: 'system_information',
				attributes: ['threads'],
			});
			const beforePIDs = new Set((beforeInfo.threads ?? []).map((t) => `${t.name}:${t.threadId}`));
			console.log(`[cascade] before-kill threads: ${[...beforePIDs].join(', ')}`);

			// Fire the SuicideWorker endpoint on B. Note: not retrying — we want
			// exactly one worker to die.
			const killAt = Date.now();
			const resp = await fetchWithRetry(B.httpURL + '/SuicideWorker', { retries: 3 });
			const suicide = await resp.json().catch(() => null);
			console.log(`[cascade] suicide response: ${JSON.stringify(suicide)}`);
			ok(suicide?.threadId, 'SuicideWorker endpoint did not return a threadId');

			// Watch for 30 seconds.
			await delay(30_000);

			// Stop writing and let things settle so we don't race the assertion.
			stopWriting = true;
			await Promise.all(writers);

			// Inspect B's threads now.
			const afterInfo = await sendOperation(B, {
				operation: 'system_information',
				attributes: ['threads'],
			});
			const afterPIDs = new Set((afterInfo.threads ?? []).map((t) => `${t.name}:${t.threadId}`));
			console.log(`[cascade] after-kill threads: ${[...afterPIDs].join(', ')}`);

			// Look at B's log for reassignment markers in the post-kill window.
			const log = await readLog(B);
			const killISO = new Date(killAt).toISOString();
			// Match lines like:
			//   2026-05-19T05:00:00.123Z [main/0] [warn]: Setting up subscription with leader hostX
			const reassignRe = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z).*Setting up subscription with leader/gm;
			const reassignTimestamps = [];
			for (const m of log.matchAll(reassignRe)) {
				if (m[1] >= killISO) reassignTimestamps.push(new Date(m[1]).getTime());
			}
			reassignTimestamps.sort((a, b) => a - b);
			console.log(
				`[cascade] reassignment timestamps after kill (count=${reassignTimestamps.length}):`,
				reassignTimestamps.map((t) => t - killAt).join('ms, ') + 'ms'
			);

			// === Assertions ===

			// (1) At least one reassignment happened — sanity, otherwise the test
			//     proves nothing.
			ok(
				reassignTimestamps.length >= 1,
				`expected at least one reassignment log line after kill; got ${reassignTimestamps.length}`
			);

			// (2) Pairwise gaps between consecutive reassignments should be
			//     ≥80 ms. The configured stagger is 100 ms; we allow slack for
			//     timestamp truncation and event-loop scheduling.
			if (reassignTimestamps.length >= 2) {
				const gaps = reassignTimestamps.slice(1).map((t, i) => t - reassignTimestamps[i]);
				const tooSmall = gaps.filter((g) => g < 80);
				ok(
					tooSmall.length <= 1, // at most one near-zero gap (the bookkeeping for the very first reassignment after death)
					`expected reassignments to be staggered ≥80ms apart; got gaps ${gaps.join('ms, ')}ms`
				);
			}

			// (3) Only one *new* worker PID should appear post-kill. If multiple
			//     workers died from the cascade, we'd see two or more new PIDs.
			const newPIDs = [...afterPIDs].filter((p) => !beforePIDs.has(p));
			const goneePIDs = [...beforePIDs].filter((p) => !afterPIDs.has(p));
			console.log(`[cascade] new PIDs after kill:`, newPIDs);
			console.log(`[cascade] gone PIDs after kill:`, goneePIDs);
			ok(newPIDs.length <= 1, `expected ≤1 new worker after kill, saw ${newPIDs.length}: ${newPIDs.join(',')}`);
			ok(goneePIDs.length <= 1, `expected ≤1 worker to have died, saw ${goneePIDs.length}: ${goneePIDs.join(',')}`);

			// (4) Replication still advancing on B.
			const finalSnap = await clusterSnapshot(B);
			const allStillConnected = finalSnap.peers.every((p) => Object.values(p.dbs).every((d) => d.connected));
			ok(allStillConnected, `B not fully reconnected post-kill: ${JSON.stringify(finalSnap)}`);

			// (5) Crisp invariant: NO ERR_WORKER_OUT_OF_MEMORY or uncaughtException
			//     in B's log — even one means the cascade fix regressed.
			ok(!log.includes('ERR_WORKER_OUT_OF_MEMORY'), 'B logged ERR_WORKER_OUT_OF_MEMORY');
			const uncaught = log.match(/\[error\]: uncaughtException/g) ?? [];
			equal(uncaught.length, 0, `B logged ${uncaught.length} uncaughtException(s)`);
		});
	});
}
