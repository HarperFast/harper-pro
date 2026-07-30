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
 *  5. Restart B. Time until its row count (exact describe_table count) converges with A.
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
	fabricRocksConfig,
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
	// RSS is a loose ceiling, not a tight bound: process RSS counts the reclaimable
	// page cache of Harper's PROT_READ mmap'd transaction logs (read in full during
	// catch-up), so it legitimately reaches several GB at 10 GB scale without any
	// memory problem. The ceiling is sized to catch a true blow-up (the original #339
	// OOM hit ~15.8 GB) while ignoring reclaimable cache. The tight regression guard is
	// ANON_CAP_MB below, on genuine (unreclaimable) memory.
	const RSS_CAP_MB = Number(process.env.HARPER_STRESS_LARGE_RSS_CAP_MB ?? 12288);
	// Cap on genuine, unreclaimable memory — container-wide cgroup `anon` (heap + native
	// allocations + RocksDB block cache/memtables). This is the real OOM-risk signal,
	// robust to the reclaimable file cache that inflates RSS. Observed ~2.4–3.6 GB.
	const ANON_CAP_MB = Number(process.env.HARPER_STRESS_LARGE_ANON_CAP_MB ?? 5120);
	// Budget: longer offline = larger backlog = more catch-up time needed. 180 s/GB is NOT marginal —
	// at the 10 GB CI scale it allows 1800 s against a typical converged time of 600–1100 s (9–17 MB/s),
	// roughly 2x headroom. Resist raising it to absorb a timeout: the observed timeouts (2026-07-19,
	// 2026-07-25) are not runs that just missed, they are runs where B never escaped the write-stall
	// trough and was still 13–35% short while decelerating. Raising the budget would hide a 4–5x
	// throughput degradation, which is the thing worth knowing. See the rate profile below.
	const CATCHUP_BUDGET_SECS = Number(
		process.env.HARPER_STRESS_LARGE_CATCHUP_BUDGET_SECS ?? Math.max(600, TARGET_GB * 180)
	);
	// A wedge, as opposed to slow replay: zero forward progress for this long. Sized well above
	// the longest legitimate gap observed between applied batches (~100s, when B's replication
	// worker is blocked inside a RocksDB write stall — see harper-pro#603), so only a genuine
	// wedge trips it.
	const STALL_SECS = Number(process.env.HARPER_STRESS_LARGE_STALL_SECS ?? 300);
	// Generous write budget: 5 min per GB plus 10 min fixed overhead.
	const WRITE_BUDGET_SECS = TARGET_GB * 300 + 600;
	const SUITE_TIMEOUT_MS = (WRITE_BUDGET_SECS + CATCHUP_BUDGET_SECS + 600) * 1000;
	const TOTAL_RECORDS = Math.ceil((TARGET_GB * 1024 * 1024 * 1024) / PAYLOAD_SIZE);
	const BATCH_COUNT = Math.ceil(TOTAL_RECORDS / BATCH_SIZE);

	// Build payload once; reused across all records to avoid per-record allocation.
	const PAYLOAD = 'x'.repeat(PAYLOAD_SIZE);

	// Pace B must sustain, on average, to finish inside the budget. Used to report how much of the
	// run was spent below the pace that can actually finish — see summariseCatchupRate.
	const REQUIRED_MBPS = (TARGET_GB * 1024) / CATCHUP_BUDGET_SECS;
	const RATE_WINDOW_SECS = 180;

	/**
	 * Catch-up throughput is strongly BIMODAL, so a single averaged MB/s is not a diagnosis.
	 * Every observed run replays fast for ~3 min (10–13 MB/s), drops into a RocksDB write-stall
	 * trough (1.5–3 MB/s), and then either climbs back out and finishes in 600–1100 s, or never
	 * does and grinds out the whole budget. Those are different failures with different causes,
	 * but the averaged number reports both as "slow replay" — the 2026-07-25 nightly timeout
	 * averaged 4.9 MB/s while its per-window rate ranged 1.5–11.1 MB/s.
	 *
	 * Summarise the rate over fixed windows so a timeout carries its own phase profile: whether B
	 * was uniformly slow, or stall-bound and never recovered.
	 */
	function summariseCatchupRate(progress, windowSecs = RATE_WINDOW_SECS) {
		const windows = [];
		if (progress.length < 2) return { windows, peakMBps: 0, slowSecs: 0 };
		const toMBps = (records, secs) => (records * PAYLOAD_SIZE) / 1024 / 1024 / secs;
		let anchor = progress[0];
		for (const sample of progress) {
			const secs = (sample.t - anchor.t) / 1000;
			if (secs < windowSecs) continue;
			// Labelled by the elapsed time at the END of the window it summarises.
			windows.push({
				toSecs: (sample.t - progress[0].t) / 1000,
				mbps: toMBps(sample.count - anchor.count, secs),
				secs,
			});
			anchor = sample;
		}
		const lastSample = progress[progress.length - 1];
		if (anchor !== lastSample) {
			// Trailing partial window — on a timeout run this is the most recent, most
			// decision-relevant data (still decelerating vs. climbing out); don't drop it.
			const secs = (lastSample.t - anchor.t) / 1000;
			if (secs > 0) {
				windows.push({
					toSecs: (lastSample.t - progress[0].t) / 1000,
					mbps: toMBps(lastSample.count - anchor.count, secs),
					secs,
				});
			}
		}
		const peakMBps = windows.reduce((max, w) => Math.max(max, w.mbps), 0);
		// Wall-clock spent below the pace that can finish in budget — the "stall-bound" measure.
		const slowSecs = windows.reduce((sum, w) => sum + (w.mbps < REQUIRED_MBPS ? w.secs : 0), 0);
		return { windows, peakMBps, slowSecs };
	}

	function formatRateProfile({ windows, peakMBps, slowSecs }) {
		if (!windows.length) return 'no rate windows (catch-up ended before one window elapsed)';
		const profile = windows.map((w) => `${w.toSecs.toFixed(0)}s:${w.mbps.toFixed(1)}`).join(' ');
		return (
			`per-${RATE_WINDOW_SECS}s MB/s [${profile}] peak=${peakMBps.toFixed(1)} ` +
			`below-required-pace(${REQUIRED_MBPS.toFixed(1)} MB/s)=${slowSecs.toFixed(0)}s`
		);
	}

	suite(`Large catch-up — ${TARGET_GB} GB`, { timeout: SUITE_TIMEOUT_MS }, (ctx) => {
		before(async () => {
			const rocks = fabricRocksConfig();
			// Catch-up throughput is gated by the WriteBufferManager budget: once B's memtables
			// exhaust it, RocksDB stalls writers and replay collapses (see harper-pro#603). Log the
			// sizing so a slow run can be read against it without re-deriving it from the env.
			console.log(
				`[large-catchup] rocks: blockCache=${mb(rocks.blockCacheSize)} wbm=${mb(rocks.writeBufferManagerSize)}`
			);
			const cfg = (host) => ({
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, console: true, level: 'warn' },
				replication: { securePort: host + ':9933' },
				storage: { rocks },
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
				const writeMBps = (writtenRecords * PAYLOAD_SIZE) / 1024 / 1024 / writeSecs;
				console.log(
					`[large-catchup] write done: ${writtenRecords}/${TOTAL_RECORDS} records in ` +
						`${writeSecs.toFixed(1)}s (${writeMBps.toFixed(1)} MB/s)`
				);

				// Convergence target is the exact count of distinct records on A: the bulk
				// rows just written plus the small seed batch. We use the known write count
				// rather than describe_table.record_count — the latter is a rounded RocksDB
				// estimate (see getRecordCount) that is wildly inflated and non-monotonic
				// during/after a bulk load, so it cannot detect convergence. This mirrors
				// the same lesson already applied in largeClone.test.mjs.
				const targetCount = writtenRecords + seedRecords.length;
				console.log(`[large-catchup] A target record count=${targetCount}; restarting B`);

				const bRestartCtx = {
					name: ctx.name,
					harper: { dataRootDir: B.dataRootDir, hostname: B.hostname },
				};
				await startHarper(bRestartCtx, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, console: true, level: 'warn' },
						replication: { securePort: B.hostname + ':9933' },
						storage: { rocks: fabricRocksConfig() },
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
				// Distinguish the two ways catch-up can miss the budget: a genuine wedge (B stops
				// advancing entirely) and merely-too-slow replay. They have completely different
				// root causes, so a plain deadline miss is not enough to tell them apart after the
				// fact — track the last forward step and fail with a distinct message on a wedge.
				let lastProgressAt = Date.now();
				let stalledFor = 0;
				// (time, count) samples behind the rate profile reported below.
				const progress = [{ t: catchupStart, count: 0 }];
				while (Date.now() < deadline) {
					// Measure convergence with an exact count, not the default
					// describe_table.record_count — the latter is a rounded RocksDB
					// estimate that diverges between nodes during bulk catch-up. The
					// exact_count flag forces a full value scan (no 500ms extrapolation
					// short-circuit in getRecordCount), giving a precise count.
					const resp = await trySendOperation(B, {
						operation: 'describe_table',
						table: 'large',
						exact_count: true,
					});
					// A failed poll (B briefly unreachable) is not progress, but it is also not
					// evidence of regression — keep the last known good count so the stall clock,
					// the over-replication guard and the final throughput report all stay honest.
					if (resp?.record_count !== undefined) {
						const prevCount = lastCount;
						lastCount = resp.record_count;
						if (lastCount > prevCount) lastProgressAt = Date.now();
						progress.push({ t: Date.now(), count: Math.max(lastCount - seedRecords.length, 0) });
					}
					stalledFor = (Date.now() - lastProgressAt) / 1000;
					ok(
						stalledFor < STALL_SECS,
						`B made no catch-up progress for ${stalledFor.toFixed(0)}s (stuck at ${lastCount}/${targetCount}) — ` +
							`replication is wedged, not merely slow`
					);
					// B replays A's distinct-id upserts, so its row count can only climb up
					// to the target. A count above it means duplicated/over-replicated rows —
					// a real catch-up regression — so fail fast rather than waiting out the
					// deadline. (Polling on the exact count keeps the break condition and this
					// guard symmetric: we converge on ===, and > is always an error.)
					ok(lastCount <= targetCount, `B row count ${lastCount} exceeds A target ${targetCount} — over-replicated`);
					if (lastCount === targetCount) {
						convergedAt = Date.now();
						break;
					}
					const remaining = Math.ceil((deadline - Date.now()) / 1000);
					console.log(
						`[large-catchup] catchup poll: B=${lastCount}/${targetCount} (${remaining}s remaining, ` +
							`stalled ${stalledFor.toFixed(0)}s)`
					);
					await delay(5_000);
				}

				const aSummary = summariseSamples(aSampler.stop());
				const bSummary = summariseSamples(bSampler.stop());
				const catchupSecs = ((convergedAt ?? Date.now()) - catchupStart) / 1000;
				// Derive throughput from the rows B actually applied rather than from TARGET_GB, so a
				// timed-out run reports the rate it did achieve. The old form divided by zero progress
				// and printed "0.0 MB/s" on every timeout, which reads as a hard wedge even when B was
				// replaying steadily the whole time — the single most misleading number in this job.
				const appliedRecords = Math.max(lastCount - seedRecords.length, 0);
				const catchupMBps = (appliedRecords * PAYLOAD_SIZE) / 1024 / 1024 / catchupSecs;
				const rateProfile = summariseCatchupRate(progress);

				console.log(
					`[large-catchup] result: catchup=${convergedAt ? catchupSecs.toFixed(1) + 's' : `TIMEOUT after ${catchupSecs.toFixed(1)}s`} ` +
						`applied=${appliedRecords}/${targetCount - seedRecords.length} ` +
						`throughput=${catchupMBps.toFixed(1)} MB/s ` +
						`A_peakRSS=${mb(aSummary.peakRss)} B_peakRSS=${mb(bSummary.peakRss)}`
				);
				// Phase profile — the averaged throughput above cannot distinguish uniformly-slow replay
				// from a stall-bound run that never recovered. See summariseCatchupRate.
				console.log(`[large-catchup] rate profile: ${formatRateProfile(rateProfile)}`);
				// Container-level cgroup breakdown (whole job container = both nodes + runner).
				// anon = genuine/unreclaimable; file = reclaimable page cache (incl. mmap'd txn
				// log read during catchup); dirty = pending writeback (vm.dirty_ratio concern).
				console.log(
					`[large-catchup] cgroup peaks: current=${mb(aSummary.peakCgroupCurrent)} ` +
						`anon=${mb(aSummary.peakCgroupAnon)} file=${mb(aSummary.peakCgroupFile)} ` +
						`dirty=${mb(aSummary.peakCgroupDirty)}`
				);

				const oomRe = /JavaScript heap out of memory|FATAL ERROR.*Allocation failed/g;
				const uncaughtRe = /\[error\]: uncaughtException/g;
				const [logA, logB] = await Promise.all([readLog(A), readLog(B)]);

				ok(
					convergedAt !== null,
					`B did not converge within ${CATCHUP_BUDGET_SECS}s; last count=${lastCount}/${targetCount} ` +
						`(applied ${appliedRecords} records at ${catchupMBps.toFixed(1)} MB/s avg — slow replay, not a wedge; ` +
						`a wedge would have tripped the ${STALL_SECS}s no-progress guard). ` +
						`Rate profile: ${formatRateProfile(rateProfile)}. ` +
						`A peak well above the required pace with most of the run below it means B was ` +
						`stall-bound and never recovered (harper-pro#430 / #435), NOT that the budget is too tight.`
				);
				for (const [name, summary, log] of [
					['A', aSummary, logA],
					['B', bSummary, logB],
				]) {
					const peakMb = summary.peakRss / 1024 / 1024;
					ok(peakMb < RSS_CAP_MB, `${name} peak RSS ${peakMb.toFixed(0)} MB exceeded ceiling ${RSS_CAP_MB} MB`);
					ok((log.match(oomRe) ?? []).length === 0, `${name} logged OOM`);
					ok((log.match(uncaughtRe) ?? []).length === 0, `${name} logged uncaughtException`);
				}
				// Tight guard on genuine memory: container-wide cgroup anon (both nodes + runner).
				// 0 when cgroup v2 is unavailable (e.g. local non-container dev) — skip there.
				const anonMb = aSummary.peakCgroupAnon / 1024 / 1024;
				if (anonMb > 0)
					ok(anonMb < ANON_CAP_MB, `container peak anon ${anonMb.toFixed(0)} MB exceeded cap ${ANON_CAP_MB} MB`);
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
