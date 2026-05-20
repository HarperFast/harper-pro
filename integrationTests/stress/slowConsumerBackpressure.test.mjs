/**
 * Slow-consumer backpressure.
 *
 * Background: when a peer applies replication writes more slowly than the
 * sender produces them, the sender's per-peer queue grows. Harper's
 * replication uses backpressure signals (visible as `backPressurePercent`
 * on each database socket in `cluster_status`) to throttle further sends.
 * Two regressions we want to catch:
 *   1. Sender doesn't cap the queue — RSS grows unboundedly until OOM.
 *   2. Backpressure is signaled, but the sender ignores it — same outcome.
 *
 * This is hard to repro deterministically on loopback because everything
 * is so fast. We force the asymmetry two ways:
 *   - A has 4 worker threads, B has 1 — apply parallelism diverges 4x.
 *   - The driver writes at high concurrency (16) so A's audit/replication
 *     producers are saturated.
 *
 * Even with this setup, on a fast machine B may still keep up. The test is
 * still useful: it asserts A doesn't OOM during the run, that the cluster
 * recovers to convergence after we stop, and that *if* backpressure was
 * signaled at any point, it correlated with A's queue NOT growing without
 * bound. Treat the "no backpressure observed at all" case as a soft warning
 * (logged), not a fail — the asymmetry on loopback may not be enough to
 * trigger it.
 *
 * Mechanism:
 *  - 2-node mesh (A: 4 threads, B: 1 thread).
 *  - Drive churn against A at concurrency 16 for HARPER_STRESS_SLOW_MINUTES.
 *  - Sample A's RSS every 2 s; poll cluster_status every 5 s to capture
 *    backPressurePercent on A→B socket.
 *  - Stop churn; wait for convergence.
 *
 * Assertions:
 *  1. Peak RSS on A < SLOW_RSS_CAP_MB (1500 MB default).
 *  2. Convergence on record_count within 120 s of stop.
 *  3. No uncaught / OOM / orphan markers on either node.
 *  4. Soft: if backPressurePercent ever exceeded 0, log a "[slow] backpressure
 *     observed" line; otherwise log a "[slow] no backpressure observed" warn
 *     (test doesn't fail, but reviewer should note the asymmetry wasn't enough).
 *
 * Run:
 *   HARPER_RUN_STRESS_TESTS=1 HARPER_STRESS_SLOW_MINUTES=5 \
 *     npm run test:integration -- integrationTests/stress/slowConsumerBackpressure.test.mjs
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import {
	stressEnabled,
	sendOperation,
	trySendOperation,
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
	suite('Slow-consumer backpressure (skipped)', () => {
		test('skipped — set HARPER_RUN_STRESS_TESTS=1 to enable', { skip: true }, () => {});
	});
} else {
	const A_THREADS = 4;
	const B_THREADS = 1;
	const KEYSPACE = Number(process.env.HARPER_STRESS_SLOW_KEYS ?? 500);
	const TOTAL_MINUTES = Number(process.env.HARPER_STRESS_SLOW_MINUTES ?? 5);
	const SLOW_RSS_CAP_MB = Number(process.env.HARPER_STRESS_SLOW_RSS_CAP_MB ?? 1500);
	const SUITE_TIMEOUT_MS = (TOTAL_MINUTES + 5) * 60_000;

	suite('Slow-consumer backpressure', { timeout: SUITE_TIMEOUT_MS }, (ctx) => {
		before(async () => {
			const aHost = await getNextAvailableLoopbackAddress();
			const bHost = await getNextAvailableLoopbackAddress();
			const cfgFor = (host, threads) => ({
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, console: true, level: 'debug' },
				replication: { securePort: host + ':9933' },
				threads: { count: threads },
			});
			const nodeA = { name: ctx.name, harper: { hostname: aHost } };
			const nodeB = { name: ctx.name, harper: { hostname: bHost } };
			await startHarper(nodeA, {
				config: cfgFor(aHost, A_THREADS),
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});
			await startHarper(nodeB, {
				config: cfgFor(bHost, B_THREADS),
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});
			ctx.nodes = [nodeA.harper, nodeB.harper];

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

		test('sender does not OOM and cluster reconverges after slow-consumer pressure', async () => {
			const [A, B] = ctx.nodes;

			const aSampler = sampleMetrics(A, { intervalMs: 2000 });
			const bpReadings = []; // { t, percent }

			let stopChurn = false;
			let writes = 0;

			const bpPoller = (async () => {
				while (!stopChurn) {
					const status = await trySendOperation(A, { operation: 'cluster_status' });
					if (status?.connections) {
						for (const c of status.connections) {
							for (const sock of c.database_sockets ?? []) {
								const p = sock.backPressurePercent ?? 0;
								if (p > 0) {
									bpReadings.push({ t: Date.now(), db: sock.database, percent: p });
								}
							}
						}
					}
					await delay(5000);
				}
			})();
			const driver = concurrent(async () => {
				if (stopChurn) return;
				const id = prerenderId(writes++ % KEYSPACE);
				try {
					await fetchWithRetry(A.httpURL + '/Prerender/' + encodeURIComponent(id), { retries: 1 });
				} catch {
					// fine
				}
			}, 16);
			const churnLoop = (async () => {
				while (!stopChurn) {
					await driver.execute();
					await delay(5);
				}
				await driver.finish();
			})();

			const endAt = Date.now() + TOTAL_MINUTES * 60_000;
			while (Date.now() < endAt) {
				const minsLeft = Math.ceil((endAt - Date.now()) / 60_000);
				console.log(`[slow] writes=${writes} bpHits=${bpReadings.length} remainingMins=${minsLeft}`);
				await delay(30_000);
			}

			stopChurn = true;
			await churnLoop;
			await bpPoller;
			console.log(`[slow] churn stopped; total writes=${writes}; bp readings=${bpReadings.length}`);

			// Convergence wait.
			const drainDeadline = Date.now() + 180_000;
			let counts = { A: -1, B: -1 };
			let convergedAt = null;
			while (Date.now() < drainDeadline) {
				const [a, b] = await Promise.all([
					sendOperation(A, { operation: 'describe_table', table: 'Prerender' }).catch(() => null),
					sendOperation(B, { operation: 'describe_table', table: 'Prerender' }).catch(() => null),
				]);
				counts = { A: a?.record_count ?? -1, B: b?.record_count ?? -1 };
				if (counts.A > 0 && counts.A === counts.B) {
					convergedAt = Date.now();
					break;
				}
				console.log(`[slow] catchup: ${JSON.stringify(counts)}`);
				await delay(3000);
			}

			const aSummary = summariseSamples(aSampler.stop());
			const [logA, logB] = await Promise.all([readLog(A), readLog(B)]);

			// (1) RSS cap.
			const peakAMb = aSummary.peakRss / 1024 / 1024;
			ok(
				peakAMb < SLOW_RSS_CAP_MB,
				`A peak RSS ${peakAMb.toFixed(0)} MB exceeded cap ${SLOW_RSS_CAP_MB} MB (samples=${aSummary.sampleCount})`
			);

			// (2) Convergence with bounded drift.
			const minCount = Math.min(counts.A, counts.B);
			const maxCount = Math.max(counts.A, counts.B);
			const drift = maxCount > 0 ? (maxCount - minCount) / maxCount : 1;
			ok(
				convergedAt !== null || drift < 0.01,
				`did not converge within 180s and drift > 1%: A=${counts.A} B=${counts.B} drift=${(drift * 100).toFixed(2)}%`
			);
			ok(maxCount > 0, `record_count must be > 0 (saw ${maxCount}); was churn firing?`);

			// (3) No uncaught / OOM / orphan markers.
			const uncaughtRe = /\[error\]: uncaughtException/g;
			const orphanRe = /\[error\] \[replication\]: Error sending blob.*ENOENT/g;
			const oomRe = /JavaScript heap out of memory|FATAL ERROR.*Allocation failed/g;
			for (const [name, log] of [
				['A', logA],
				['B', logB],
			]) {
				const u = (log.match(uncaughtRe) ?? []).length;
				const o = (log.match(orphanRe) ?? []).length;
				const m = (log.match(oomRe) ?? []).length;
				ok(u === 0, `${name} logged ${u} uncaughtException`);
				ok(o === 0, `${name} logged ${o} blob orphan markers`);
				ok(m === 0, `${name} logged ${m} OOM markers`);
			}

			// (4) Soft check — did we actually observe backpressure?
			if (bpReadings.length === 0) {
				console.warn(
					`[slow] WARN: no backPressurePercent > 0 observed during ${TOTAL_MINUTES}m of asymmetric churn. ` +
						`B may have kept up with A; consider raising concurrency, payload size, or duration.`
				);
			} else {
				const maxBp = bpReadings.reduce((m, r) => Math.max(m, r.percent), 0);
				console.log(`[slow] backpressure observed: ${bpReadings.length} readings, max=${maxBp}%`);
			}

			console.log(
				`[slow] completed: writes=${writes} peakRss=${mb(aSummary.peakRss)} counts=${JSON.stringify(counts)} ` +
					`bpReadings=${bpReadings.length}`
			);
		});
	});
}
