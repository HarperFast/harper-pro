/**
 * Large-dataset replication catch-up performance.
 *
 * Background: When a node rejoins after a long offline window it must replay
 * every write its peers accumulated while it was gone. This test validates
 * that the catch-up path handles production-scale data volumes (configured
 * via HARPER_STRESS_LARGE_DATA_GB) without OOM and sustains a floor throughput,
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
 *  6. Hard-fail on: a wedge (no forward progress for STALL_SECS), over-replication,
 *     OOM / uncaughtException / RSS or cgroup-anon blow-up, A exiting mid-write, and
 *     average catch-up throughput below CATCHUP_FLOOR_MBPS. A run that is merely slow
 *     — above the floor but under CATCHUP_BASELINE_MBPS — warns and is recorded, so a
 *     busy shared runner does not turn the nightly red.
 *  7. Emit write throughput, catch-up throughput and host-pressure counters, to the
 *     run log, the job summary, and `large-catchup-metrics.json` in the log artifact.
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
	sampleHostCounters,
	summariseHostSamples,
	formatHostCounters,
	writeStressMetrics,
	clearStressMetrics,
	writeJobSummary,
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
	// Catch-up throughput on this workload is BIMODAL on identical code: at 10 GB the
	// nightly has measured 13.5 / 11.4 / 10.0 MB/s in runs that converge quickly and
	// ~5.1 MB/s in runs that plod, with no code, config or host-contention difference
	// between them (runner-side loadavg/iowait/PSI/disk were no worse on the slow
	// nights). A fixed wall-clock budget therefore cannot separate "slow but healthy"
	// from "regressed" — it just fails whichever mode happens to land past the line.
	//
	// So the hard gate is a throughput FLOOR, not a clock: the deadline is the time the
	// floor rate needs for this dataset, plus a grace for B's restart/reconnect before
	// the first batch lands. The floor sits at half the slowest healthy run observed, so
	// a genuine ~2x replication regression still fails while ordinary spread does not.
	// CATCHUP_BASELINE_MBPS is the *tracked* number: falling under it warns and is
	// recorded in the metrics artifact, it does not fail the job.
	const CATCHUP_FLOOR_MBPS = Number(process.env.HARPER_STRESS_LARGE_CATCHUP_FLOOR_MBPS ?? 2.5);
	const CATCHUP_BASELINE_MBPS = Number(process.env.HARPER_STRESS_LARGE_CATCHUP_BASELINE_MBPS ?? 10);
	const CATCHUP_GRACE_SECS = Number(process.env.HARPER_STRESS_LARGE_CATCHUP_GRACE_SECS ?? 120);
	const CATCHUP_BUDGET_SECS = Number(
		process.env.HARPER_STRESS_LARGE_CATCHUP_BUDGET_SECS ??
			Math.max(600, Math.ceil((TARGET_GB * 1024) / CATCHUP_FLOOR_MBPS) + CATCHUP_GRACE_SECS)
	);
	// The rate the budget actually enforces. Equal to CATCHUP_FLOOR_MBPS at CI scale;
	// looser at small TARGET_GB (the 600s minimum dominates) or when the budget is
	// overridden outright — so failure messages quote a number that is always true.
	const ENFORCED_FLOOR_MBPS = (TARGET_GB * 1024) / Math.max(CATCHUP_BUDGET_SECS - CATCHUP_GRACE_SECS, 1);
	// A wedge, as opposed to slow replay: zero forward progress for this long. Sized well above
	// the longest legitimate gap observed between applied batches (~100s, when B's replication
	// worker is blocked inside a RocksDB write stall — see harper-pro#603), so only a genuine
	// wedge trips it.
	const STALL_SECS = Number(process.env.HARPER_STRESS_LARGE_STALL_SECS ?? 300);
	// The convergence poll's exact_count forces a full value scan of B's table (see the
	// comment at the poll site), and that scan grows with B's row count and competes with
	// replication replay for the same RocksDB I/O/CPU it's trying to measure — a 5s cadence
	// means dozens of full-table scans self-contaminate the very throughput being gated.
	// Widening the interval cuts scan overhead roughly proportionally; STALL_SECS (300s) and
	// the metrics/log cadence stay coarse-poll-friendly at this interval.
	const CATCHUP_POLL_SECS = Number(process.env.HARPER_STRESS_LARGE_CATCHUP_POLL_SECS ?? 15);
	// Generous write budget: 5 min per GB plus 10 min fixed overhead.
	const WRITE_BUDGET_SECS = TARGET_GB * 300 + 600;
	const SUITE_TIMEOUT_MS = (WRITE_BUDGET_SECS + CATCHUP_BUDGET_SECS + 600) * 1000;
	const TOTAL_RECORDS = Math.ceil((TARGET_GB * 1024 * 1024 * 1024) / PAYLOAD_SIZE);
	const BATCH_COUNT = Math.ceil(TOTAL_RECORDS / BATCH_SIZE);

	// Build payload once; reused across all records to avoid per-record allocation.
	const PAYLOAD = 'x'.repeat(PAYLOAD_SIZE);

	suite(`Large catch-up — ${TARGET_GB} GB`, { timeout: SUITE_TIMEOUT_MS }, (ctx) => {
		before(async () => {
			clearStressMetrics('large-catchup');
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
			// Host-level pressure, sampled from /proc (not namespaced by Docker, so this is
			// the whole box, not the job container). The in-container cgroup stats look
			// identical on fast and slow nights, so these counters are the only way to
			// attribute a slow run to a busy runner after the fact.
			const hostSampler = sampleHostCounters({ intervalMs: 5_000 });
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
				// Write-phase host pressure, captured before the window resets for catch-up.
				// A host-wide slowdown shows up in both phases; a replication-only slowdown
				// leaves this line looking like a healthy night's.
				const writeHost = hostSampler.window();
				console.log(`[large-catchup] write host: ${formatHostCounters(writeHost)}`);

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
				// Re-baseline the host counters here so both the per-poll lines and the
				// catch-up summary measure the catch-up phase alone, excluding B's restart.
				hostSampler.window();
				const hostCatchupFrom = Math.max(hostSampler.samples.length - 1, 0);

				const deadline = Date.now() + CATCHUP_BUDGET_SECS * 1000;
				let lastCount = -1;
				let convergedAt = null;
				// Distinguish the two ways catch-up can miss the budget: a genuine wedge (B stops
				// advancing entirely) and merely-too-slow replay. They have completely different
				// root causes, so a plain deadline miss is not enough to tell them apart after the
				// fact — track the last forward step and fail with a distinct message on a wedge.
				let lastProgressAt = Date.now();
				let stalledFor = 0;
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
							`stalled ${stalledFor.toFixed(0)}s) ${formatHostCounters(hostSampler.window())}`
					);
					await delay(CATCHUP_POLL_SECS * 1000);
				}

				const aSummary = summariseSamples(aSampler.stop());
				const bSummary = summariseSamples(bSampler.stop());
				const hostSummary = summariseHostSamples(hostSampler.stop().slice(hostCatchupFrom));
				const catchupSecs = ((convergedAt ?? Date.now()) - catchupStart) / 1000;
				// Derive throughput from the rows B actually applied rather than from TARGET_GB, so a
				// timed-out run reports the rate it did achieve. The old form divided by zero progress
				// and printed "0.0 MB/s" on every timeout, which reads as a hard wedge even when B was
				// replaying steadily the whole time — the single most misleading number in this job.
				const appliedRecords = Math.max(lastCount - seedRecords.length, 0);
				const catchupMBps = (appliedRecords * PAYLOAD_SIZE) / 1024 / 1024 / catchupSecs;

				console.log(
					`[large-catchup] result: catchup=${convergedAt ? catchupSecs.toFixed(1) + 's' : `TIMEOUT after ${catchupSecs.toFixed(1)}s`} ` +
						`applied=${appliedRecords}/${targetCount - seedRecords.length} ` +
						`throughput=${catchupMBps.toFixed(1)} MB/s ` +
						`A_peakRSS=${mb(aSummary.peakRss)} B_peakRSS=${mb(bSummary.peakRss)}`
				);
				// Container-level cgroup breakdown (whole job container = both nodes + runner).
				// anon = genuine/unreclaimable; file = reclaimable page cache (incl. mmap'd txn
				// log read during catchup); dirty = pending writeback (vm.dirty_ratio concern).
				console.log(
					`[large-catchup] cgroup peaks: current=${mb(aSummary.peakCgroupCurrent)} ` +
						`anon=${mb(aSummary.peakCgroupAnon)} file=${mb(aSummary.peakCgroupFile)} ` +
						`dirty=${mb(aSummary.peakCgroupDirty)}`
				);
				// Host pressure across the catch-up phase. Read this line first when a run is
				// slow: healthy numbers here mean the slowdown was Harper's, not the runner's.
				console.log(`[large-catchup] host (catch-up): ${formatHostCounters(hostSummary)}`);
				if (hostSummary)
					console.log(
						`[large-catchup] host peaks: load1=${hostSummary.peakLoad1.toFixed(2)} ` +
							`iowait=${hostSummary.peakIowaitPct.toFixed(0)}% psiIo=${hostSummary.peakPsiIoPct.toFixed(0)}% ` +
							`psiCpu=${hostSummary.peakPsiCpuPct.toFixed(0)}% ` +
							`minMemAvail=${(hostSummary.minMemAvailableKb / 1024).toFixed(0)} MB`
					);

				// Throughput is the tracked metric; the baseline is a warning, not a gate. Emit it
				// as an Actions annotation so a downward trend is visible on the run page before it
				// ever gets slow enough to trip the floor.
				if (catchupMBps < CATCHUP_BASELINE_MBPS)
					console.log(
						`::warning title=large-catchup below baseline::catch-up ${catchupMBps.toFixed(1)} MB/s is under the ` +
							`${CATCHUP_BASELINE_MBPS} MB/s baseline (hard floor ${ENFORCED_FLOOR_MBPS.toFixed(1)} MB/s)`
					);

				const metrics = {
					targetGb: TARGET_GB,
					converged: convergedAt !== null,
					catchupSecs: Number(catchupSecs.toFixed(1)),
					catchupMBps: Number(catchupMBps.toFixed(2)),
					appliedRecords,
					targetRecords: targetCount - seedRecords.length,
					writeSecs: Number(writeSecs.toFixed(1)),
					writeMBps: Number(writeMBps.toFixed(2)),
					budgetSecs: CATCHUP_BUDGET_SECS,
					floorMBps: CATCHUP_FLOOR_MBPS,
					enforcedFloorMBps: Number(ENFORCED_FLOOR_MBPS.toFixed(2)),
					baselineMBps: CATCHUP_BASELINE_MBPS,
					stallSecs: STALL_SECS,
					peakRss: { A: aSummary.peakRss, B: bSummary.peakRss },
					cgroupPeaks: {
						current: aSummary.peakCgroupCurrent,
						anon: aSummary.peakCgroupAnon,
						file: aSummary.peakCgroupFile,
						dirty: aSummary.peakCgroupDirty,
					},
					hostWritePhase: writeHost,
					hostCatchup: hostSummary,
				};
				writeStressMetrics('large-catchup', metrics);
				writeJobSummary(
					`### large-catchup (${TARGET_GB} GB)\n\n` +
						`| metric | value |\n| --- | --- |\n` +
						`| catch-up | ${convergedAt ? catchupSecs.toFixed(1) + 's' : 'TIMEOUT after ' + catchupSecs.toFixed(1) + 's'} |\n` +
						`| throughput | ${catchupMBps.toFixed(1)} MB/s (baseline ${CATCHUP_BASELINE_MBPS}, floor ${CATCHUP_FLOOR_MBPS}) |\n` +
						`| applied | ${appliedRecords}/${targetCount - seedRecords.length} |\n` +
						`| write | ${writeMBps.toFixed(1)} MB/s |\n` +
						`| host | ${formatHostCounters(hostSummary)} |\n`
				);

				const oomRe = /JavaScript heap out of memory|FATAL ERROR.*Allocation failed/g;
				const uncaughtRe = /\[error\]: uncaughtException/g;
				const [logA, logB] = await Promise.all([readLog(A), readLog(B)]);

				// Gate on the measured rate itself, not on "did it converge before the deadline".
				// The deadline is grace-padded (CATCHUP_GRACE_SECS added on top of the floor-implied
				// time) so B has room to reconnect before the first batch lands, but a run that
				// consumes that whole padded window to converge posts a catchupMBps below
				// ENFORCED_FLOOR_MBPS despite convergedAt being non-null — convergedAt!==null alone
				// let that pass. Checking the rate directly closes that gap and still fails an
				// outright timeout for free (partial progress over the full budget is always < the
				// rate needed to finish it).
				ok(
					catchupMBps >= ENFORCED_FLOOR_MBPS,
					`B averaged ${catchupMBps.toFixed(1)} MB/s, under the ${ENFORCED_FLOOR_MBPS.toFixed(1)} MB/s catch-up floor ` +
						`(${appliedRecords}/${targetCount - seedRecords.length} records in ${catchupSecs.toFixed(1)}s` +
						`${convergedAt ? '' : ', TIMED OUT'}) — ` +
						`slow replay, not a wedge; a wedge would have tripped the ${STALL_SECS}s no-progress guard. ` +
						`Host during catch-up: ${formatHostCounters(hostSummary)}`
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
				hostSampler.stop();
			}
		});
	});
}
