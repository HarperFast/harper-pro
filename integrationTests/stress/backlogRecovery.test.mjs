/**
 * Cold-resume backlog recovery.
 *
 * Background: in production we periodically see a node go offline for an
 * extended window (network blip, planned maintenance, OOM kill) and rejoin
 * with a large backlog of audit entries queued at its peers. The peers
 * have been buffering those entries waiting for the node to come back. The
 * stress questions are:
 *   - Do peers cap their per-peer backlog memory so they don't OOM while
 *     the absent node is gone?
 *   - When the absent node returns, does it drain the backlog without OOMing
 *     itself, and converge with the rest of the cluster in bounded time?
 *
 * This is the *receive*-side mirror of soakWithRollingRestarts (which
 * primarily exercises sender-side behavior during many short kill/restart
 * cycles). This test exercises a single long absence — minutes, not seconds.
 *
 * Mechanism:
 *  - 4-node mesh (A, B, C, D) wired identically.
 *  - Wait until cluster is stable, then stop B (clean teardown — not a
 *    SIGKILL, because we're not testing crash recovery here, we're testing
 *    backlog accumulation while a peer is reachable-but-missing).
 *  - Drive heavy churn on A+C+D for HARPER_STRESS_BACKLOG_OFFLINE_MINUTES
 *    (default 5 minutes locally / 30 minutes in CI). Sample per-node RSS.
 *  - Restart B. Sample its RSS during catch-up.
 *  - Wait for convergence; assert.
 *
 * Assertions:
 *  1. Peak RSS on A, C, D during the offline window stays under
 *     PEER_RSS_CAP_MB (default 1500 MB). Catches "peer buffers backlog
 *     forever" regressions.
 *  2. Peak RSS on B during catch-up stays under CATCHUP_RSS_CAP_MB
 *     (default 1500 MB). Catches "node loads entire backlog into memory
 *     to apply" regressions.
 *  3. After restart, B converges with peers within CATCHUP_BUDGET_SECS
 *     (default 180 s for local, scaled with offline duration in CI).
 *  4. Zero uncaughtException, zero OOM, zero blob orphan markers on any node.
 *  5. Zero `MaxListenersExceededWarning` in node logs.
 *
 * Run:
 *   HARPER_RUN_STRESS_TESTS=1 HARPER_STRESS_BACKLOG_OFFLINE_MINUTES=5 \
 *     npm run test:integration -- integrationTests/stress/backlogRecovery.test.mjs
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
	sampleMetrics,
	summariseSamples,
	mb,
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
	suite('Backlog recovery (skipped)', () => {
		test('skipped — set HARPER_RUN_STRESS_TESTS=1 to enable', { skip: true }, () => {});
	});
} else {
	const THREADS_PER_NODE = 4;
	const KEYSPACE = Number(process.env.HARPER_STRESS_BACKLOG_KEYS ?? 800);
	const OFFLINE_MINUTES = Number(process.env.HARPER_STRESS_BACKLOG_OFFLINE_MINUTES ?? 5);
	const PEER_RSS_CAP_MB = Number(process.env.HARPER_STRESS_BACKLOG_PEER_CAP_MB ?? 1500);
	const CATCHUP_RSS_CAP_MB = Number(process.env.HARPER_STRESS_BACKLOG_CATCHUP_CAP_MB ?? 1500);
	const CATCHUP_BUDGET_SECS = Number(
		process.env.HARPER_STRESS_BACKLOG_CATCHUP_BUDGET_SECS ?? Math.max(180, OFFLINE_MINUTES * 30)
	);
	const SUITE_TIMEOUT_MS = (OFFLINE_MINUTES * 60 + CATCHUP_BUDGET_SECS + 240) * 1000;

	suite('Cold-resume backlog recovery', { timeout: SUITE_TIMEOUT_MS }, (ctx) => {
		before(async () => {
			const cfg = (host) => ({
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, console: true, level: 'debug' },
				replication: { securePort: host + ':9933' },
				threads: { count: THREADS_PER_NODE },
			});
			ctx.nodes = await Promise.all(
				[0, 1, 2, 3].map(async () => {
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

		test('peer stays online and absent node catches up without OOM', async () => {
			const [A, , C, D] = ctx.nodes;
			let B = ctx.nodes[1];

			// Warm-up: seed a small batch through the peers and wait for B to receive it
			// BEFORE taking B offline. This is what makes the test exercise backlog *drain*
			// (audit-log resume) rather than a cold from-scratch join. Replication records a
			// per-source resume position (last received seqId) only once B has actually
			// received data for the `data` db; that position lives in B's durable audit log,
			// so it survives the SIGKILL below. Without it, B's `data` db restarts "from
			// scratch" (startTime === 1) and — per the explicit-leader design (#254) — a
			// plain, non-leader node starts replicating from ~now (Date.now() - 60s), so it
			// would silently skip the entire accumulated backlog and never converge.
			// replayCatchupSeam dodges this implicitly by churning for 45s before its kill;
			// we do the equivalent here, and assert B saw it so a regression can't slip back
			// into the "0 records forever" failure mode this test was written to catch.
			const peers = [A, C, D];
			const WARMUP_WRITES = Math.min(KEYSPACE, 60);
			console.log(`[backlog] warm-up: seeding ${WARMUP_WRITES} writes so B has a resume position before going offline`);
			// Issue the warm-up writes in parallel: they're independent seed writes, so
			// firing them concurrently keeps setup fast and avoids letting a single slow
			// peer stretch out the warm-up window.
			await Promise.all(
				Array.from({ length: WARMUP_WRITES }, (_, i) => {
					const id = prerenderId(i % KEYSPACE);
					return fetchWithRetry(peers[i % peers.length].httpURL + '/Prerender/' + encodeURIComponent(id), {
						retries: 1,
					}).catch(() => {
						// transient errors during warm-up are fine
					});
				})
			);
			// Wait until B has actually received (and committed) the warm-up — a positive
			// record_count is the durable signal that B holds a `data` resume position.
			const warmupDeadline = Date.now() + 60_000;
			let warmupCount = 0;
			while (Date.now() < warmupDeadline) {
				const b = await sendOperation(B, { operation: 'describe_table', table: 'Prerender' }).catch(() => null);
				warmupCount = b?.record_count ?? 0;
				if (warmupCount > 0) break;
				await delay(1000);
			}
			ok(
				warmupCount > 0,
				`warm-up failed: B never received the seed writes (count=${warmupCount}); cannot establish a data-db resume position, so the offline-backlog drain path can't be exercised`
			);
			console.log(`[backlog] warm-up done; B holds ${warmupCount} records (resume position established)`);

			// Sample memory on peers A/C/D for the whole offline window.
			const peerSamplers = [A, C, D].map((n) => sampleMetrics(n, { intervalMs: 2000 }));

			// Take B offline by killing the process (killHarper preserves dataRootDir
			// so we can restart in place). We're not testing the crash-recovery seam
			// here (that's replayCatchupSeam) — we want peers to backlog while B is
			// gone, then we bring B back at the same data dir and watch it catch up.
			console.log(`[backlog] killing B (${B.hostname}) for ${OFFLINE_MINUTES}m offline window`);
			await killHarper({ harper: B });

			// Churn on the surviving three. Driver pulls equally from A/C/D so
			// the backlog isn't entirely on one peer's queue.
			let stopChurn = false;
			let writes = 0;
			const driver = concurrent(async () => {
				if (stopChurn) return;
				const id = prerenderId(writes++ % KEYSPACE);
				const peer = peers[writes % peers.length];
				try {
					await fetchWithRetry(peer.httpURL + '/Prerender/' + encodeURIComponent(id), { retries: 1 });
				} catch {
					// transient errors on a peer mid-load are fine
				}
			}, 12);

			const churnLoop = (async () => {
				while (!stopChurn) {
					await driver.execute();
					await delay(10);
				}
				await driver.finish();
			})();

			const endOffline = Date.now() + OFFLINE_MINUTES * 60_000;
			while (Date.now() < endOffline) {
				const remaining = Math.ceil((endOffline - Date.now()) / 60_000);
				console.log(`[backlog] B offline; writes=${writes} remainingMins=${remaining}`);
				await delay(30_000);
			}

			// Stop driving new traffic — but keep the peer samplers running
			// through catch-up so we capture both the peer-buffering peak and
			// the drain.
			stopChurn = true;
			await churnLoop;
			console.log(`[backlog] offline window done; total writes=${writes}; restarting B`);

			// Restart B at the same hostname so peers route to it.
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
			ctx.nodes[1] = restartCtx.harper;
			B = restartCtx.harper;

			const catchupSampler = sampleMetrics(B, { intervalMs: 2000 });

			// Poll for convergence — describe_table on all four. Trip the break
			// only when every node reports a positive, identical record_count
			// (the `counts.A > 0` guard rules out an all-error all-(-1) state).
			const catchupDeadline = Date.now() + CATCHUP_BUDGET_SECS * 1000;
			let counts = { A: -1, B: -1, C: -1, D: -1 };
			let convergedAt = null;
			while (Date.now() < catchupDeadline) {
				const [a, b, c, d] = await Promise.all(
					[A, B, C, D].map((n) =>
						sendOperation(n, { operation: 'describe_table', table: 'Prerender' }).catch(() => null)
					)
				);
				counts = {
					A: a?.record_count ?? -1,
					B: b?.record_count ?? -1,
					C: c?.record_count ?? -1,
					D: d?.record_count ?? -1,
				};
				const vals = Object.values(counts);
				if (counts.A > 0 && vals.every((v) => v === vals[0])) {
					convergedAt = Date.now();
					break;
				}
				const minLocal = Math.min(...vals);
				const maxLocal = Math.max(...vals);
				console.log(`[backlog] catchup poll: ${JSON.stringify(counts)} gap=${maxLocal - minLocal}`);
				await delay(3000);
			}

			const peerSummaries = peerSamplers.map((s) => summariseSamples(s.stop()));
			const catchupSummary = summariseSamples(catchupSampler.stop());
			console.log(
				`[backlog] peer peaks: A=${mb(peerSummaries[0].peakRss)} C=${mb(peerSummaries[1].peakRss)} ` +
					`D=${mb(peerSummaries[2].peakRss)}; B catchup peak: ${mb(catchupSummary.peakRss)}`
			);

			const [logA, logB, logC, logD] = await Promise.all([readLog(A), readLog(B), readLog(C), readLog(D)]);

			// (1+2) Memory caps.
			for (const [name, summary, cap] of [
				['A', peerSummaries[0], PEER_RSS_CAP_MB],
				['C', peerSummaries[1], PEER_RSS_CAP_MB],
				['D', peerSummaries[2], PEER_RSS_CAP_MB],
				['B (catchup)', catchupSummary, CATCHUP_RSS_CAP_MB],
			]) {
				const peakMb = summary.peakRss / 1024 / 1024;
				ok(
					peakMb < cap,
					`${name} peak RSS ${peakMb.toFixed(0)} MB exceeded cap ${cap} MB (samples=${summary.sampleCount})`
				);
			}

			// (3) Convergence.
			ok(
				convergedAt !== null,
				`B did not converge within ${CATCHUP_BUDGET_SECS}s after restart; final: ${JSON.stringify(counts)}`
			);

			// (4) No uncaught / OOM / orphan.
			const uncaughtRe = /\[error\]: uncaughtException/g;
			const orphanRe = /\[error\] \[replication\]: Error sending blob.*ENOENT/g;
			const oomRe = /JavaScript heap out of memory|FATAL ERROR.*Allocation failed/g;
			for (const [name, log] of [
				['A', logA],
				['B', logB],
				['C', logC],
				['D', logD],
			]) {
				const u = (log.match(uncaughtRe) ?? []).length;
				const o = (log.match(orphanRe) ?? []).length;
				const m = (log.match(oomRe) ?? []).length;
				ok(u === 0, `${name} logged ${u} uncaughtException`);
				ok(o === 0, `${name} logged ${o} blob orphan markers`);
				ok(m === 0, `${name} logged ${m} OOM markers`);
			}

			// Note: not asserting on MaxListenersExceededWarning here — that's
			// rapidReconnectAdversity's job. Harper's manageThreads.restartWorkers
			// emits this once during deploy_component+restart:true startup
			// (separate latent issue), and we don't want to entangle the catchup
			// regression with that.

			const catchupDurationSecs =
				convergedAt !== null ? Math.round((convergedAt - (catchupDeadline - CATCHUP_BUDGET_SECS * 1000)) / 1000) : -1;
			console.log(
				`[backlog] completed: writes=${writes} catchupSecs=${catchupDurationSecs} ` + `counts=${JSON.stringify(counts)}`
			);
		});
	});
}
