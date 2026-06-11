/**
 * Large-dataset clone performance.
 *
 * Background: When adding a new node to a cluster that holds production-scale
 * data, the clone path must copy the full dataset before the node becomes
 * Available. This test validates that process completes in bounded time, stays
 * within memory limits, and emits throughput so we can track regressions.
 *
 * Requires a self-hosted runner with adequate free disk (≥ 3× target data
 * size). The ubuntu-latest GH runner (~14 GB usable) cannot fit 10+ GB.
 *
 * Scenario:
 *  1. Start a single source node A and write TARGET_GB of row data to it.
 *  2. Start a blank node B pointed at A via HDB_LEADER_URL (clone mode).
 *  3. Time from clone start until B reports availability: Available.
 *  4. Assert: row count matches; no OOM; completes within CLONE_BUDGET_SECS.
 *  5. Emit write throughput and clone throughput.
 *
 * Run locally (1 GB, ~10–20 min):
 *   HARPER_RUN_STRESS_TESTS=1 HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR=~/dev/tmp \
 *     npm run test:integration -- integrationTests/stress/largeClone.test.mjs
 *
 * Run at CI scale (10 GB):
 *   HARPER_RUN_STRESS_TESTS=1 HARPER_STRESS_LARGE_DATA_GB=10 \
 *     npm run test:integration -- integrationTests/stress/largeClone.test.mjs
 */

import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	stressEnabled,
	sendOperation,
	trySendOperation,
	concurrent,
	readLog,
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
	suite('Large clone (skipped)', () => {
		test('skipped — set HARPER_RUN_STRESS_TESTS=1 to enable', { skip: true }, () => {});
	});
} else {
	const TARGET_GB = Number(process.env.HARPER_STRESS_LARGE_DATA_GB ?? 1);
	const PAYLOAD_SIZE = 100 * 1024; // 100 KB per record
	const BATCH_SIZE = 20;
	const CONCURRENCY = 8;
	const RSS_CAP_MB = Number(process.env.HARPER_STRESS_LARGE_RSS_CAP_MB ?? 3072);
	const CLONE_BUDGET_SECS = Number(process.env.HARPER_STRESS_LARGE_CLONE_BUDGET_SECS ?? Math.max(600, TARGET_GB * 180));
	const WRITE_BUDGET_SECS = TARGET_GB * 300 + 600;
	const SUITE_TIMEOUT_MS = (WRITE_BUDGET_SECS + CLONE_BUDGET_SECS + 600) * 1000;
	const TOTAL_RECORDS = Math.ceil((TARGET_GB * 1024 * 1024 * 1024) / PAYLOAD_SIZE);
	const BATCH_COUNT = Math.ceil(TOTAL_RECORDS / BATCH_SIZE);

	const PAYLOAD = 'x'.repeat(PAYLOAD_SIZE);

	suite(`Large clone — ${TARGET_GB} GB`, { timeout: SUITE_TIMEOUT_MS }, (ctx) => {
		before(async () => {
			const leaderCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			await startHarper(leaderCtx, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, console: true, level: 'warn' },
					replication: { port: leaderCtx.harper.hostname + ':9933', securePort: null },
					threads: { count: 4 },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});
			ctx.leaderCtx = leaderCtx;
			ctx.leader = leaderCtx.harper;

			await sendOperation(ctx.leader, {
				operation: 'create_table',
				table: 'large',
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'payload', type: 'String' },
				],
			});

			// Write TARGET_GB of data to the leader.
			// Monitor leader's process: if Harper crashes during the write phase, abort
			// immediately rather than hanging until the write-budget deadline.
			let leaderProcessExited = false;
			const leaderExitWatcher = new Promise((_, reject) => {
				ctx.leader.process?.once('exit', (code, signal) => {
					leaderProcessExited = true;
					reject(new Error(`[large-clone] Harper leader exited unexpectedly (${signal ?? code}) during write phase`));
				});
			});

			console.log(`[large-clone] writing ${TARGET_GB} GB (${TOTAL_RECORDS} records) to leader`);
			const writeStart = Date.now();
			let batchIndex = 0;

			const writeDeadline = writeStart + WRITE_BUDGET_SECS * 1000;

			const pool = concurrent(async () => {
				const bi = batchIndex++;
				const start = bi * BATCH_SIZE;
				const end = Math.min(start + BATCH_SIZE, TOTAL_RECORDS);
				if (start >= TOTAL_RECORDS) return;
				const records = Array.from({ length: end - start }, (_, j) => ({
					id: `bulk-${start + j}`,
					payload: PAYLOAD,
				}));
				// 30 s per-request timeout so a dead leader fails fast rather than
				// hanging until the 60-minute write-budget deadline.
				await sendOperation(ctx.leader, { operation: 'upsert', table: 'large', records }, { timeoutMs: 30_000 });
			}, CONCURRENCY);

			// Race the write loop against the leader-process exit watcher.
			await Promise.race([
				(async () => {
					for (let b = 0; b < BATCH_COUNT && Date.now() < writeDeadline; b++) {
						await pool.execute();
						if (b % 200 === 0) {
							const pct = Math.round((b / BATCH_COUNT) * 100);
							const elapsed = ((Date.now() - writeStart) / 1000).toFixed(0);
							console.log(`[large-clone] write ${pct}% (batch ${b}/${BATCH_COUNT}, ${elapsed}s elapsed)`);
						}
					}
					await pool.finish();
				})(),
				leaderExitWatcher,
			]);

			const writeSecs = (Date.now() - writeStart) / 1000;
			// Use actual written record count (not describe_table.record_count which
			// returns an internal storage counter, not the logical row count).
			const writtenRecords = Math.min(batchIndex * BATCH_SIZE, TOTAL_RECORDS);
			const writeMBps = (writtenRecords * PAYLOAD_SIZE / 1024 / 1024) / writeSecs;
			console.log(
				`[large-clone] write done: ${writtenRecords}/${TOTAL_RECORDS} records in ${writeSecs.toFixed(1)}s (${writeMBps.toFixed(1)} MB/s)`
			);
			ctx.leaderRecordCount = writtenRecords;
		});

		after(async () => {
			const live = [ctx.leaderCtx, ctx.cloneCtx].filter((c) => c?.harper?.process);
			await Promise.all(live.map((c) => teardownHarper(c).catch(() => null)));
		});

		test('clone completes in bounded time and row count matches', async () => {
			const tokenResp = await sendOperation(ctx.leader, {
				operation: 'create_authentication_tokens',
				authorization: ctx.leader.admin,
				expires_in: '60Minutes',
			});

			const cloneCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			ctx.cloneCtx = cloneCtx;

			const cloneSampler = sampleMetrics(cloneCtx.harper, { intervalMs: 5_000 });
			// Note: sampleMetrics won't capture until the node is up, but we start
			// it here so we get coverage from the moment the process is alive.
			const cloneStart = Date.now();

			await startHarper(cloneCtx, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, console: true, level: 'warn' },
					replication: { port: cloneCtx.harper.hostname + ':9933', securePort: null },
					threads: { count: 4 },
				},
				env: {
					HDB_LEADER_URL: `http://${ctx.leader.hostname}:9925`,
					HDB_LEADER_TOKEN: tokenResp.operation_token,
					ALLOW_SELF_SIGNED: true,
					HARPER_NO_FLUSH_ON_EXIT: true,
				},
			});

			// Log progress while waiting.
			let available = false;
			const deadline = Date.now() + CLONE_BUDGET_SECS * 1000;
			while (Date.now() < deadline && !available) {
				try {
					const resp = await trySendOperation(cloneCtx.harper, { operation: 'get_status', id: 'availability' });
					if (resp?.status === 'Available') {
						available = true;
						break;
					}
					const count =
						(await trySendOperation(cloneCtx.harper, { operation: 'describe_table', table: 'large' }))?.record_count ??
						-1;
					const remaining = Math.ceil((deadline - Date.now()) / 1000);
					console.log(
						`[large-clone] clone progress: count=${count}/${ctx.leaderRecordCount} status=${resp?.status ?? 'unknown'} (${remaining}s remaining)`
					);
				} catch {}
				await delay(5_000);
			}

			const cloneSecs = (Date.now() - cloneStart) / 1000;
			const cloneMBps = available ? (TARGET_GB * 1024) / cloneSecs : 0;
			const cloneSummary = summariseSamples(cloneSampler.stop());

			console.log(
				`[large-clone] result: clone=${available ? cloneSecs.toFixed(1) + 's' : 'TIMEOUT'} ` +
					`throughput=${cloneMBps.toFixed(1)} MB/s ` +
					`clone_peakRSS=${mb(cloneSummary.peakRss)}`
			);

			const cloneLog = await readLog(cloneCtx.harper);
			const oomRe = /JavaScript heap out of memory|FATAL ERROR.*Allocation failed/g;
			const uncaughtRe = /\[error\]: uncaughtException/g;

			ok(available, `Clone did not reach Available within ${CLONE_BUDGET_SECS}s`);
			const peakMb = cloneSummary.peakRss / 1024 / 1024;
			ok(peakMb < RSS_CAP_MB, `Clone peak RSS ${peakMb.toFixed(0)} MB exceeded cap ${RSS_CAP_MB} MB`);
			ok((cloneLog.match(oomRe) ?? []).length === 0, 'clone logged OOM');
			ok((cloneLog.match(uncaughtRe) ?? []).length === 0, 'clone logged uncaughtException');

			// Verify row count matches after clone completes.
			let finalCount = -1;
			for (let i = 0; i < 30; i++) {
				const resp = await trySendOperation(cloneCtx.harper, { operation: 'describe_table', table: 'large' });
				finalCount = resp?.record_count ?? -1;
				if (finalCount >= ctx.leaderRecordCount) break;
				await delay(2_000);
			}
			equal(finalCount, ctx.leaderRecordCount, `Clone row count ${finalCount} != leader ${ctx.leaderRecordCount}`);
		});
	});
}
