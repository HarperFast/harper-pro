/**
 * Crash recovery seam — replayLogs vs replication catch-up.
 *
 * Background: when a Harper node SIGKILLs with HARPER_NO_FLUSH_ON_EXIT=true,
 * its on-disk audit log carries the last few committed-but-unflushed entries.
 * On restart, replayLogs.ts walks that tail and re-applies it to the table
 * stores. Meanwhile, peers — which already have those same versions from
 * live replication before the crash — kick off catch-up to push anything the
 * crashed node missed *after* the last entry it saw.
 *
 * The seam between these two flows is the interesting part: the same audit
 * version range can be visible to both replayLogs (locally) and catch-up
 * (from peers). Apply rules must be idempotent — re-applying the same
 * version must not produce duplicate rows, lost rows, or corrupt structures.
 * Subtle bugs here would show up as record_count drift, "Error writing from
 * replay of log" stack traces, or "msgpack/structure decode failed" entries.
 *
 * Mechanism:
 *  - 3-node mesh (A leader, B + C followers), all four-thread.
 *  - Drive churn against A's Prerender table (mixed inline + blob payloads)
 *    so the audit + replication traffic is realistic.
 *  - Once traffic is flowing, SIGKILL B with HARPER_NO_FLUSH_ON_EXIT so its
 *    audit tail is unflushed. Restart it immediately. Continue churn so
 *    catch-up overlaps with replay.
 *  - Stop traffic. Wait for convergence.
 *
 * Assertions:
 *  1. record_count drift across all three nodes < 1 % (replay didn't double-apply
 *     and catch-up didn't lose rows).
 *  2. B logs include at least one "Replayed N records" warn (i.e. the seam was
 *     actually exercised — if zero replays, the test isn't proving anything).
 *  3. Zero "Error writing from replay of log" and zero "Error committing replay
 *     transaction" lines on any node.
 *  4. Zero uncaughtException, zero blob orphan markers (since blobs are involved
 *     in the workload), zero OOM markers.
 *
 * Run:
 *   HARPER_RUN_STRESS_TESTS=1 \
 *     npm run test:integration -- integrationTests/stress/replayCatchupSeam.test.mjs
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
	suite('Replay/catch-up seam (skipped)', () => {
		test('skipped — set HARPER_RUN_STRESS_TESTS=1 to enable', { skip: true }, () => {});
	});
} else {
	const THREADS_PER_NODE = 4;
	const KEYSPACE = Number(process.env.HARPER_STRESS_REPLAY_KEYS ?? 200);
	const PRE_KILL_SECS = Number(process.env.HARPER_STRESS_REPLAY_PRE_KILL_SECS ?? 45);
	const POST_KILL_SECS = Number(process.env.HARPER_STRESS_REPLAY_POST_KILL_SECS ?? 60);
	const SUITE_TIMEOUT_MS = (PRE_KILL_SECS + POST_KILL_SECS + 240) * 1000;

	suite('Crash recovery: replayLogs vs catch-up seam', { timeout: SUITE_TIMEOUT_MS }, (ctx) => {
		before(async () => {
			const cfg = (host) => ({
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, console: true, level: 'debug' },
				replication: { securePort: host + ':9933' },
				threads: { count: THREADS_PER_NODE },
			});
			ctx.nodes = await Promise.all(
				[0, 1, 2].map(async () => {
					const node = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
					await startHarper(node, { config: cfg(node.harper.hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
					return node.harper;
				})
			);

			const tokenResp = await sendOperation(ctx.nodes[0], {
				operation: 'create_authentication_tokens',
				authorization: ctx.nodes[0].admin,
			});
			for (let i = 1; i < ctx.nodes.length; i++) {
				await sendOperation(ctx.nodes[i], {
					operation: 'add_node',
					rejectUnauthorized: false,
					hostname: ctx.nodes[0].hostname,
					authorization: 'Bearer ' + tokenResp.operation_token,
				});
			}
			for (let i = 1; i < ctx.nodes.length; i++) {
				await waitForAllConnected(ctx.nodes[i], { timeoutMs: 60_000 });
			}

			const payload = await targz(join(import.meta.dirname, 'fixture-prerender-workload'));
			await sendOperation(ctx.nodes[0], {
				operation: 'deploy_component',
				project: 'prerender-workload',
				payload,
				replicated: true,
				restart: true,
			});
			await delay(40_000);
			for (let i = 1; i < ctx.nodes.length; i++) {
				await waitForAllConnected(ctx.nodes[i], { timeoutMs: 90_000 });
			}
		});

		after(async () => {
			if (!ctx.nodes) return;
			await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n }).catch(() => null)));
		});

		test('post-crash replay overlaps with catch-up without duplicating or losing rows', async () => {
			const A = ctx.nodes[0];
			let B = ctx.nodes[1];
			const C = ctx.nodes[2];

			let stopChurn = false;
			let writes = 0;
			const driver = concurrent(async () => {
				if (stopChurn) return;
				const id = prerenderId(writes++ % KEYSPACE);
				try {
					await fetchWithRetry(A.httpURL + '/Prerender/' + encodeURIComponent(id), { retries: 1 });
				} catch {
					// transient errors during the crash window are fine
				}
			}, 8);
			const churnLoop = (async () => {
				while (!stopChurn) {
					await driver.execute();
					await delay(15);
				}
				await driver.finish();
			})();

			console.log(`[replay] settling ${PRE_KILL_SECS}s of pre-kill churn`);
			await delay(PRE_KILL_SECS * 1000);

			console.log(`[replay] SIGKILL B (${B.hostname}) with HARPER_NO_FLUSH_ON_EXIT`);
			await killHarper({ harper: B });

			const restartCtx = {
				name: ctx.name,
				harper: { dataRootDir: B.dataRootDir, hostname: B.hostname },
			};
			await startHarper(restartCtx, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, console: true, level: 'debug' },
					replication: { securePort: B.hostname + ':9933' },
					threads: { count: THREADS_PER_NODE },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});
			// Keep a reference to the pre-restart (killed) instance: its log dir is where the
			// restart's startup replay actually lands. With HARPER_INTEGRATION_TEST_LOG_DIR set (CI),
			// each startHarper mints a fresh timestamped log dir, but on boot Harper replays the
			// transaction log *before* the runtime config override repoints logging.root — so the
			// "Replayed N records" line is written to the killed instance's log dir, not the restarted
			// one. readLog(B) alone would miss it (see assertion (2) below).
			const killedB = B;
			ctx.nodes[1] = restartCtx.harper;
			B = restartCtx.harper;
			console.log(`[replay] B restarted; ${POST_KILL_SECS}s post-kill churn`);

			await delay(POST_KILL_SECS * 1000);
			stopChurn = true;
			await churnLoop;

			console.log('[replay] churn stopped; waiting for convergence (up to 120s)');
			const drainDeadline = Date.now() + 120_000;
			let counts = { A: -1, B: -1, C: -1 };
			while (Date.now() < drainDeadline) {
				const [a, b, c] = await Promise.all([
					sendOperation(A, { operation: 'describe_table', table: 'Prerender' }).catch(() => null),
					sendOperation(B, { operation: 'describe_table', table: 'Prerender' }).catch(() => null),
					sendOperation(C, { operation: 'describe_table', table: 'Prerender' }).catch(() => null),
				]);
				counts = {
					A: a?.record_count ?? -1,
					B: b?.record_count ?? -1,
					C: c?.record_count ?? -1,
				};
				if (counts.A > 0 && counts.A === counts.B && counts.A === counts.C) break;
				await delay(2000);
			}
			console.log(`[replay] convergence done: ${JSON.stringify(counts)}`);

			// B's log spans two instances: the killed one and the restart. The startup replay is
			// written to the killed instance's log dir (see the killedB comment above), while live
			// post-restart activity goes to the restart's. Concatenate both so every B-side assertion
			// (replay happened, no replay errors, no uncaught/OOM) sees the full picture. When
			// HARPER_INTEGRATION_TEST_LOG_DIR is unset, both resolve to the shared dataRootDir log and
			// readLog returns identical content; the Set de-dupes that case and filter(Boolean) drops
			// an empty/missing log so no stray newline is introduced.
			const [logA, logBkilled, logBrestart, logC] = await Promise.all([
				readLog(A),
				readLog(killedB),
				readLog(B),
				readLog(C),
			]);
			const logB = [...new Set([logBkilled, logBrestart].filter(Boolean))].join('\n');

			// (1) Convergence — strict drift bound, but tolerate a few in-flight rows.
			const vals = Object.values(counts);
			const minCount = Math.min(...vals);
			const maxCount = Math.max(...vals);
			const drift = maxCount > 0 ? (maxCount - minCount) / maxCount : 0;
			ok(drift < 0.01, `record_count diverged > 1%: ${JSON.stringify(counts)} drift ${(drift * 100).toFixed(2)}%`);
			ok(maxCount > 0, `record_count must be > 0 (saw ${maxCount}); was churn firing?`);

			// (2) B must have actually replayed — otherwise the seam wasn't exercised.
			const replayedRe = /\[warn\].*Replayed \d+ records in .* database/g;
			const replayLines = logB.match(replayedRe) ?? [];
			ok(
				replayLines.length > 0,
				`B did not log any "Replayed N records" — test did not exercise replay. This searches both the killed and restarted instance logs, so the cause is genuinely that replay did not fire: HARPER_NO_FLUSH_ON_EXIT not honored, or the kill happened before any unflushed writes existed. Sample of B log tail:\n${logB.slice(-2000)}`
			);

			// (3) No replay errors on any node.
			const replayErrRe = /Error (writing from replay of log|committing replay transaction)/g;
			const replayErrorsA = logA.match(replayErrRe) ?? [];
			const replayErrorsB = logB.match(replayErrRe) ?? [];
			const replayErrorsC = logC.match(replayErrRe) ?? [];
			ok(
				replayErrorsA.length === 0 && replayErrorsB.length === 0 && replayErrorsC.length === 0,
				`replay errors: A=${replayErrorsA.length} B=${replayErrorsB.length} C=${replayErrorsC.length}. ` +
					`Sample: ${replayErrorsB[0] ?? replayErrorsA[0] ?? replayErrorsC[0]}`
			);

			// (4) No uncaught / OOM / orphan markers.
			const uncaughtRe = /\[error\]: uncaughtException/g;
			const orphanRe = /\[error\] \[replication\]: Error sending blob.*ENOENT/g;
			const oomRe = /JavaScript heap out of memory|FATAL ERROR.*Allocation failed/g;
			for (const [name, log] of [
				['A', logA],
				['B', logB],
				['C', logC],
			]) {
				const u = (log.match(uncaughtRe) ?? []).length;
				const o = (log.match(orphanRe) ?? []).length;
				const m = (log.match(oomRe) ?? []).length;
				ok(u === 0, `${name} logged ${u} uncaughtException`);
				ok(o === 0, `${name} logged ${o} blob orphan markers`);
				ok(m === 0, `${name} logged ${m} OOM markers`);
			}

			console.log(
				`[replay] completed: writes=${writes} counts=${JSON.stringify(counts)} ` + `replayLines=${replayLines.length}`
			);
		});
	});
}
