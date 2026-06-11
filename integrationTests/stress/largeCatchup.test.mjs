/**
 * Large-dataset replication catch-up performance.
 *
 * Background: When a node rejoins after a long offline window it must replay
 * every write its peers accumulated while it was gone. This test validates
 * that the catch-up path handles production-scale data volumes (configured
 * via HARPER_STRESS_LARGE_DATA_GB) without OOM and completes in bounded time,
 * and emits throughput numbers so we can track regressions across releases.
 *
 * Requires a self-hosted runner with adequate free disk (≥ 3× target data
 * size). The ubuntu-latest GH runner (~14 GB usable) cannot fit 10+ GB.
 *
 * Scenario:
 *  1. 2-node cluster (A + B), both replicating.
 *  2. Create a table on A; seed a small baseline so B has a non-zero start.
 *  3. Take B offline (clean teardown).
 *  4. Write TARGET_GB of bulk row data to A while B is offline.
 *  5. Restart B. Time until its record_count converges with A.
 *  6. Assert: convergence within CATCHUP_BUDGET_SECS; no OOM on either node.
 *  7. Emit write throughput and catch-up throughput.
 *
 * Run locally (1 GB, ~10–20 min):
 *   HARPER_RUN_STRESS_TESTS=1 HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR=~/dev/tmp \
 *     npm run test:integration -- integrationTests/stress/largeCatchup.test.mjs
 *
 * Run at CI scale (10 GB):
 *   HARPER_RUN_STRESS_TESTS=1 HARPER_STRESS_LARGE_DATA_GB=10 \
 *     npm run test:integration -- integrationTests/stress/largeCatchup.test.mjs
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import {
	startHarper,
	teardownHarper,
	killHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import {
	stressEnabled,
	sendOperation,
	trySendOperation,
	concurrent,
	readLog,
	waitForAllConnected,
	sampleMetrics,
	summariseSamples,
	mb,
} from './stressShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = resolve(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

if (!stressEnabled()) {
	suite('Large catch-up (skipped)', () => {
		test('skipped — set HARPER_RUN_STRESS_TESTS=1 to enable', { skip: true }, () => {});
	});
} else {
	const TARGET_GB = Number(process.env.HARPER_STRESS_LARGE_DATA_GB ?? 1);
	const PAYLOAD_SIZE = 100 * 1024; // 100 KB per record
	const BATCH_SIZE = 20;
	const CONCURRENCY = 8;
	const RSS_CAP_MB = Number(process.env.HARPER_STRESS_LARGE_RSS_CAP_MB ?? 3072);
	// Budget: longer offline = larger backlog = more catch-up time needed.
	const CATCHUP_BUDGET_SECS = Number(
		process.env.HARPER_STRESS_LARGE_CATCHUP_BUDGET_SECS ?? Math.max(600, TARGET_GB * 180)
	);
	// Generous write budget: 5 min per GB plus 10 min fixed overhead.
	const WRITE_BUDGET_SECS = TARGET_GB * 300 + 600;
	const SUITE_TIMEOUT_MS = (WRITE_BUDGET_SECS + CATCHUP_BUDGET_SECS + 600) * 1000;
	const TOTAL_RECORDS = Math.ceil((TARGET_GB * 1024 * 1024 * 1024) / PAYLOAD_SIZE);
	const BATCH_COUNT = Math.ceil(TOTAL_RECORDS / BATCH_SIZE);

	// Build payload once; reused across all records to avoid per-record allocation.
	const PAYLOAD = 'x'.repeat(PAYLOAD_SIZE);

	suite(`Large catch-up — ${TARGET_GB} GB`, { timeout: SUITE_TIMEOUT_MS }, (ctx) => {
		before(async () => {
			const cfg = (host) => ({
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, console: true, level: 'warn' },
				replication: { securePort: host + ':9933' },
				threads: { count: 4 },
			});

			ctx.nodes = await Promise.all(
				[0, 1].map(async () => {
					const node = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
					await startHarper(node, { config: cfg(node.harper.hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
					return node.harper;
				})
			);

			const [A, B] = ctx.nodes;
			const tokenResp = await sendOperation(A, {
				operation: 'create_authentication_tokens',
				authorization: A.admin,
			});
			await sendOperation(B, {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: A.hostname,
				authorization: 'Bearer ' + tokenResp.operation_token,
			});
			await waitForAllConnected(B, { timeoutMs: 60_000 });

			await sendOperation(A, {
				operation: 'create_table',
				table: 'large',
				primary_key: 'id',
				replicated: true,
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'payload', type: 'String' },
				],
			});
			// Allow schema to propagate before seeding.
			await delay(5_000);
		});

		after(async () => {
			if (!ctx.nodes) return;
			await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n }).catch(() => null)));
		});

		test('B catches up after A accumulates large offline backlog', async () => {
			const [A] = ctx.nodes;
			let B = ctx.nodes[1];

			// Small seed so B starts with a non-zero baseline.
			const seedRecords = Array.from({ length: 100 }, (_, i) => ({
				id: `seed-${i}`,
				payload: 'seed',
			}));
			await sendOperation(A, { operation: 'upsert', table: 'large', records: seedRecords });
			await delay(3_000);

			console.log(`[large-catchup] stopping B; will write ${TARGET_GB} GB (${TOTAL_RECORDS} records) to A`);
			await killHarper({ harper: B });

			// Write bulk data to A while B is offline.
			// Monitor A's process: if Harper crashes during the write phase, abort
			// immediately rather than hanging until the write-budget deadline.
			let _aProcessExited = false;
			const aExitWatcher = new Promise((_, reject) => {
				A.process?.once('exit', (code, signal) => {
					_aProcessExited = true;
					reject(new Error(`[large-catchup] Harper A exited unexpectedly (${signal ?? code}) during write phase`));
				});
			});

			const aSampler = sampleMetrics(A, { intervalMs: 5_000 });
			let bSampler = null;
			let testDone = false;
			try {
			const writeStart = Date.now();
			const writeDeadline = writeStart + WRITE_BUDGET_SECS * 1000;
			let batchIndex = 0;

			const pool = concurrent(async () => {
				const bi = batchIndex++;
				const start = bi * BATCH_SIZE;
				const end = Math.min(start + BATCH_SIZE, TOTAL_RECORDS);
				if (start >= TOTAL_RECORDS) return;
				const records = Array.from({ length: end - start }, (_, j) => ({
					id: `bulk-${start + j}`,
					payload: PAYLOAD,
				}));
				// 30 s per-request timeout so a dead A node fails fast rather than
				// hanging until the 60-minute write-budget deadline.
				// Silently drop errors after testDone so that in-flight requests
				// abandoned when Promise.race settles don't become unhandled rejections.
				try {
					await sendOperation(A, { operation: 'upsert', table: 'large', records }, { timeoutMs: 30_000 });
				} catch (err) {
					if (testDone) return;
					throw err;
				}
			}, CONCURRENCY);

			// Race the write loop against the A-process exit watcher so a crash
			// surfaces immediately instead of blocking until the write-budget deadline.
			await Promise.race([
				(async () => {
					for (let b = 0; b < BATCH_COUNT && Date.now() < writeDeadline; b++) {
						await pool.execute();
						if (b % 200 === 0) {
							const pct = Math.round((b / BATCH_COUNT) * 100);
							const elapsed = ((Date.now() - writeStart) / 1000).toFixed(0);
							console.log(`[large-catchup] write ${pct}% (batch ${b}/${BATCH_COUNT}, ${elapsed}s elapsed)`);
						}
					}
					await pool.finish();
				})(),
				aExitWatcher,
			]);

			const writeSecs = (Date.now() - writeStart) / 1000;
			const writtenRecords = Math.min(batchIndex * BATCH_SIZE, TOTAL_RECORDS);
			const writeMBps = (writtenRecords * PAYLOAD_SIZE / 1024 / 1024) / writeSecs;
			console.log(
				`[large-catchup] write done: ${writtenRecords}/${TOTAL_RECORDS} records in ` +
					`${writeSecs.toFixed(1)}s (${writeMBps.toFixed(1)} MB/s)`
			);

			const aDescribe = await sendOperation(A, { operation: 'describe_table', table: 'large' });
			const targetCount = aDescribe.record_count;
			console.log(`[large-catchup] A record_count=${targetCount}; restarting B`);

			const bRestartCtx = {
				name: ctx.name,
				harper: { dataRootDir: B.dataRootDir, hostname: B.hostname },
			};
			await startHarper(bRestartCtx, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, console: true, level: 'warn' },
					replication: { securePort: B.hostname + ':9933' },
					threads: { count: 4 },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});
			ctx.nodes[1] = bRestartCtx.harper;
			B = bRestartCtx.harper;

			const catchupStart = Date.now();
			bSampler = sampleMetrics(B, { intervalMs: 5_000 });

			const deadline = Date.now() + CATCHUP_BUDGET_SECS * 1000;
			let lastCount = -1;
			let convergedAt = null;
			while (Date.now() < deadline) {
				const resp = await trySendOperation(B, { operation: 'describe_table', table: 'large' });
				lastCount = resp?.record_count ?? -1;
				if (lastCount >= targetCount) {
					convergedAt = Date.now();
					break;
				}
				const remaining = Math.ceil((deadline - Date.now()) / 1000);
				console.log(
					`[large-catchup] catchup poll: B=${lastCount}/${targetCount} (${remaining}s remaining)`
				);
				await delay(5_000);
			}

			const aSummary = summariseSamples(aSampler.stop());
			const bSummary = summariseSamples(bSampler.stop());
			const catchupSecs = convergedAt ? (convergedAt - catchupStart) / 1000 : -1;
			const catchupMBps = convergedAt ? (TARGET_GB * 1024) / catchupSecs : 0;

			console.log(
				`[large-catchup] result: catchup=${convergedAt ? catchupSecs.toFixed(1) + 's' : 'TIMEOUT'} ` +
					`throughput=${catchupMBps.toFixed(1)} MB/s ` +
					`A_peakRSS=${mb(aSummary.peakRss)} B_peakRSS=${mb(bSummary.peakRss)}`
			);

			const oomRe = /JavaScript heap out of memory|FATAL ERROR.*Allocation failed/g;
			const uncaughtRe = /\[error\]: uncaughtException/g;
			const [logA, logB] = await Promise.all([readLog(A), readLog(B)]);

			ok(convergedAt !== null, `B did not converge within ${CATCHUP_BUDGET_SECS}s; last count=${lastCount}`);
			for (const [name, summary, log] of [
				['A', aSummary, logA],
				['B', bSummary, logB],
			]) {
				const peakMb = summary.peakRss / 1024 / 1024;
				ok(peakMb < RSS_CAP_MB, `${name} peak RSS ${peakMb.toFixed(0)} MB exceeded cap ${RSS_CAP_MB} MB`);
				ok((log.match(oomRe) ?? []).length === 0, `${name} logged OOM`);
				ok((log.match(uncaughtRe) ?? []).length === 0, `${name} logged uncaughtException`);
			}
			} finally {
				// Signal pool tasks to swallow errors — prevents unhandled rejections
				// from in-flight requests that time out after the test exits.
				testDone = true;
				// Always stop samplers so their timers don't keep the event loop alive
				// after an early exit (e.g. Harper crash during write phase).
				aSampler.stop();
				bSampler?.stop();
			}
		});
	});
}
