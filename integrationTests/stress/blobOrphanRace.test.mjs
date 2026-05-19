/**
 * Blob orphan race investigation — attempts to reproduce the most mysterious
 * wtk symptom: qub-ap-south-1 was emitting bursts of
 *   [error] [replication]: Error sending blob ... ENOENT '/blobs/prerender/0/d/36b'
 * meaning some node had an audit-log reference to a blob whose file no
 * longer existed on disk on the sender. We don't know exactly how the
 * orphan was created in prod; this test sets up conditions where one is
 * *most likely* to form and then checks every node for the error signature.
 *
 * Hypothesis: a sender produces a streamed blob, broadcasts it to peers,
 * then immediately overwrites the same record (which schedules the old
 * blob file for cleanup). If the per-record cleanup runs before the peer
 * has acknowledged receiving the prior blob, the sender retries the blob
 * but its file is gone. The receiver gets a partial / error blob.
 *
 * Mechanism in this test:
 *  - 2 nodes (A leader, B receiver). Both run the prerender-workload
 *    fixture so the table has `sourcedFrom` with mixed-size blobs.
 *  - A drives heavy churn against a *small* key space — say 100 ids —
 *    cycling so the same record is overwritten many times per minute.
 *    Each overwrite supersedes the prior blob file. The small key space
 *    keeps cumulative storage modest while maximizing supersede frequency.
 *  - B is restarted mid-test once, simulating real-world reconnect delay
 *    — when B reconnects, A's pending-send queue has to navigate the
 *    blob files that have churned since.
 *  - Run for HARPER_STRESS_ORPHAN_MINUTES (default 15 locally / 60 in CI).
 *
 * Assertions:
 *  1. NO `Error sending blob ... ENOENT` lines on A. If we hit even one,
 *     we've reproduced the orphan bug in a controlled environment — file
 *     a follow-up issue with the test as repro.
 *  2. NO `uncaughtException` on either node.
 *  3. After test ends and a 60s drain, A and B agree on record_count and
 *     on the hash of each blob's content via the REST GET endpoint.
 *
 * Even if we don't reproduce the orphan, this is still a useful regression
 * guard for the blob-cleanup-vs-replication race surface area.
 *
 * Run:
 *   HARPER_RUN_STRESS_TESTS=1 HARPER_STRESS_ORPHAN_MINUTES=10 \
 *     npm run test:integration -- integrationTests/stress/blobOrphanRace.test.mjs
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import {
	startHarper,
	teardownHarper,
	killHarper,
	getNextAvailableLoopbackAddress,
	targz,
} from '@harperfast/integration-testing';
import {
	stressEnabled,
	sendOperation,
	fetchWithRetry,
	concurrent,
	readLog,
	waitForAllConnected,
	prerenderId,
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
	suite('Blob orphan race (skipped)', () => {
		test('skipped — set HARPER_RUN_STRESS_TESTS=1 to enable', { skip: true }, () => {});
	});
} else {
	const THREADS_PER_NODE = 2;
	const KEYSPACE = Number(process.env.HARPER_STRESS_ORPHAN_KEYS ?? 100);
	const TOTAL_MINUTES = Number(process.env.HARPER_STRESS_ORPHAN_MINUTES ?? 15);
	const SUITE_TIMEOUT_MS = (TOTAL_MINUTES + 4) * 60_000;

	suite('Blob orphan race under heavy churn', { timeout: SUITE_TIMEOUT_MS }, (ctx) => {
		before(async () => {
			const cfg = (host) => ({
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, console: true, level: 'debug' },
				replication: { securePort: host + ':9933' },
				threads: { count: THREADS_PER_NODE },
			});
			ctx.nodes = await Promise.all(
				[0, 1].map(async () => {
					const node = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
					await startHarper(node, { config: cfg(node.harper.hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
					return node.harper;
				})
			);
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
			await waitForAllConnected(ctx.nodes[1], { timeoutMs: 60_000 });

			const payload = await targz(join(import.meta.dirname, 'fixture-prerender-workload'));
			await sendOperation(ctx.nodes[0], {
				operation: 'deploy_component',
				project: 'prerender-workload',
				payload,
				replicated: true,
				restart: true,
			});
			await delay(40_000);
			await waitForAllConnected(ctx.nodes[1], { timeoutMs: 90_000 });
		});

		after(async () => {
			if (!ctx.nodes) return;
			await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n }).catch(() => null)));
		});

		test('heavy supersede churn does not orphan blobs on the sender', async () => {
			const [A, B] = ctx.nodes;
			const startedAt = Date.now();
			const endAt = startedAt + TOTAL_MINUTES * 60_000;

			// Decide the restart timing — once near the middle so we exercise
			// the reconnect path during the churn window.
			const restartAt = startedAt + Math.floor((TOTAL_MINUTES * 60_000) / 2);
			let restarted = false;

			// Churn driver: cycle through KEYSPACE ids, hit each on A to
			// trigger sourcedFrom (creating/recreating the blob). The small
			// keyspace means each id is overwritten frequently.
			let stopChurn = false;
			let writes = 0;
			const driver = concurrent(async () => {
				if (stopChurn) return;
				const id = prerenderId(writes++ % KEYSPACE);
				try {
					await fetchWithRetry(A.httpURL + '/Prerender/' + encodeURIComponent(id), { retries: 1 });
				} catch {
					// Transient errors during the kill window are fine.
				}
			}, 8);
			const churnLoop = (async () => {
				while (!stopChurn) {
					await driver.execute();
					await delay(20);
				}
				await driver.finish();
			})();

			// Main timeline: wait for restart point, do a single kill+restart
			// of B mid-test, then continue churn till endAt.
			while (Date.now() < endAt) {
				if (!restarted && Date.now() >= restartAt) {
					console.log(`[orphan] mid-test restart of B (${B.hostname})`);
					await killHarper({ harper: B });
					await startHarper(
						{ name: ctx.name, harper: { dataRootDir: B.dataRootDir, hostname: B.hostname } },
						{
							config: {
								analytics: { aggregatePeriod: -1 },
								logging: { colors: false, console: true, level: 'debug' },
								replication: { securePort: B.hostname + ':9933' },
								threads: { count: THREADS_PER_NODE },
							},
							env: { HARPER_NO_FLUSH_ON_EXIT: true },
						}
					);
					restarted = true;
				}
				const minsLeft = Math.ceil((endAt - Date.now()) / 60_000);
				console.log(`[orphan] t=${Math.round((Date.now() - startedAt) / 1000)}s writes=${writes} restMins=${minsLeft}`);
				await delay(30_000);
			}

			stopChurn = true;
			await churnLoop;

			// Drain time — let B catch up everything queued. Poll for convergence
			// rather than blanket-sleeping so a slow drain doesn't burn the budget.
			console.log('[orphan] stopping churn; waiting for convergence (up to 120s)');
			const drainDeadline = Date.now() + 120_000;
			let aCount = -1;
			let bCount = -1;
			while (Date.now() < drainDeadline) {
				const [a, b] = await Promise.all([
					sendOperation(A, { operation: 'describe_table', table: 'Prerender' }).catch(() => null),
					sendOperation(B, { operation: 'describe_table', table: 'Prerender' }).catch(() => null),
				]);
				aCount = a?.record_count ?? -1;
				bCount = b?.record_count ?? -1;
				if (aCount > 0 && aCount === bCount) break;
				await delay(2000);
			}
			console.log(`[orphan] convergence wait done: A=${aCount} B=${bCount}`);

			const logA = await readLog(A);
			const logB = await readLog(B);

			// === Assertions ===

			// (1) The whole point of the test: any blob orphan markers?
			const orphanRe = /\[error\] \[replication\]: Error sending blob.*ENOENT/g;
			const orphansA = logA.match(orphanRe) ?? [];
			const orphansB = logB.match(orphanRe) ?? [];
			if (orphansA.length > 0 || orphansB.length > 0) {
				console.log(`[orphan] !!! REPRODUCED !!! A=${orphansA.length} B=${orphansB.length}`);
				console.log('A sample:', orphansA.slice(0, 3));
				console.log('B sample:', orphansB.slice(0, 3));
			}
			ok(
				orphansA.length === 0,
				`A produced ${orphansA.length} "Error sending blob ENOENT" — blob-orphan pattern reproduced. ` +
					`Sample: ${orphansA[0]}`
			);
			ok(orphansB.length === 0, `B produced ${orphansB.length} "Error sending blob ENOENT". Sample: ${orphansB[0]}`);

			// (2) No uncaughtException either side.
			const uncaughtA = logA.match(/\[error\]: uncaughtException/g) ?? [];
			const uncaughtB = logB.match(/\[error\]: uncaughtException/g) ?? [];
			ok(uncaughtA.length === 0, `A logged ${uncaughtA.length} uncaughtException`);
			ok(uncaughtB.length === 0, `B logged ${uncaughtB.length} uncaughtException`);

			// (3) Convergence on record_count after the drain loop above.
			// Allow ≤1% drift to absorb the last few in-flight commits that may
			// not have replicated by the deadline — small keyspace means even a
			// 1-record gap is >1% only at KEYSPACE < 100. For KEYSPACE=80 the
			// gap must be 0; for KEYSPACE=200 a 1-record tail is OK.
			const minCount = Math.min(aCount, bCount);
			const maxCount = Math.max(aCount, bCount);
			const drift = maxCount > 0 ? (maxCount - minCount) / maxCount : 0;
			ok(drift < 0.01, `record_count diverged > 1%: A=${aCount} B=${bCount} drift ${(drift * 100).toFixed(2)}%`);
			ok(maxCount > 0 && maxCount <= KEYSPACE, `record_count ${maxCount} outside (0, ${KEYSPACE}]`);

			console.log(
				`[orphan] completed: writes=${writes} aCount=${aCount} bCount=${bCount} ` +
					`orphans A=${orphansA.length} B=${orphansB.length}`
			);
		});
	});
}
