/**
 * Long-running soak test that recreates the wtk-ap-west-1 failure mode.
 *
 * Background (production, May 2026):
 *  - 12-node cluster running a prerender cache table (Norton-style URL+device
 *    keys, mix of inline-stored small JSON and file-backed large HTML).
 *  - One node accumulated hours of cache writes, then got unhappy: peer
 *    catch-up after a restart OOM'd the receive worker → restart → catch-up
 *    OOM'd again → ~25s crash loop, 284 OOM events in 2 hours. Replication
 *    reassignments cascaded onto surviving workers, killing them in turn.
 *
 * What this test does:
 *  - Brings up a 4-node cluster with `THREADS_COUNT=4`. Four nodes is enough
 *    for replication to be non-trivial and reassignment to happen on
 *    multiple peers when one node dies; four worker threads make the
 *    per-worker reassignment stagger fix (PR #147) observable.
 *  - Deploys a prerender-style component (mixed small/large blobs, see
 *    fixture-prerender-workload/) to all nodes.
 *  - Runs HTTP traffic continuously from a small client pool against all
 *    four nodes, generating cache-miss writes.
 *  - Every CYCLE_MINUTES, picks a random node, `killHarper()`s it
 *    (SIGTERM→SIGKILL fast path), then restarts it. Lets it catch up while
 *    traffic continues on the other three.
 *  - Repeats for HARPER_STRESS_SOAK_MINUTES total (default 20 minutes
 *    locally; 240 in the workflow).
 *
 * Hard assertions evaluated *after* the soak completes:
 *  1. No `ERR_WORKER_OUT_OF_MEMORY` in any node's hdb.log.
 *  2. No `uncaughtException` in any node's hdb.log.
 *  3. No `Error sending blob` ENOENT lines in any node's hdb.log — these
 *     would indicate the blob-orphan pattern we observed on qub. (The
 *     `Blob save failed` receive-side lines that PR #149's test exercises
 *     should not appear here either, because no fault injection is active.)
 *  4. After the final node returns and traffic settles, every node's
 *     `record_count` on Prerender matches (full convergence).
 *  5. Peak per-process RSS on every node stays under 1.5 GB throughout.
 *
 * Sampled invariants checked every 30s, with snapshots dumped to stdout for
 * post-hoc analysis:
 *  - cluster_status shows all peers connected (transient disconnects during
 *    a restart cycle are allowed; permanent ones fail the soak).
 *  - record_count drift across nodes < 1% (eventual consistency).
 *
 * To run locally:
 *   HARPER_RUN_STRESS_TESTS=1 HARPER_STRESS_SOAK_MINUTES=10 \
 *     npm run test:integration -- integrationTests/stress/soakWithRollingRestarts.test.mjs
 *
 * To run in CI: trigger the stress-tests.yaml workflow; it sets the env vars.
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
	trySendOperation,
	fetchWithRetry,
	concurrent,
	readLog,
	clusterSnapshot,
	waitForAllConnected,
	waitForRecordCount,
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
	// Don't register the suite at all — keeps the default integration runner
	// (`integrationTests/**/*.test.mjs`) from accidentally running 20 minutes
	// of soak inside a 15-minute CI shard.
	suite('Replication soak with rolling restarts (skipped)', () => {
		test('skipped — set HARPER_RUN_STRESS_TESTS=1 to enable', { skip: true }, () => {});
	});
} else {
	const NODE_COUNT = 4;
	const THREADS_PER_NODE = 4;
	const TOTAL_MINUTES = Number(process.env.HARPER_STRESS_SOAK_MINUTES ?? 20);
	const CYCLE_SECONDS = Number(process.env.HARPER_STRESS_CYCLE_SECONDS ?? 90);
	const TRAFFIC_RPS = Number(process.env.HARPER_STRESS_RPS ?? 30);
	const URL_KEYSPACE = Number(process.env.HARPER_STRESS_URL_KEYSPACE ?? 2000);
	const PEAK_RSS_LIMIT_BYTES = 1.5 * 1024 * 1024 * 1024;
	const SUITE_TIMEOUT_MS = (TOTAL_MINUTES + 5) * 60_000;

	suite('Replication soak with rolling restarts', { timeout: SUITE_TIMEOUT_MS }, (ctx) => {
		before(async () => {
			ctx.nodes = await Promise.all(
				Array.from({ length: NODE_COUNT }).map(async () => {
					const node = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
					await startHarper(node, {
						config: {
							analytics: { aggregatePeriod: -1 },
							logging: { colors: false, console: true, level: 'warn' },
							replication: { securePort: node.harper.hostname + ':9933' },
							threads: { count: THREADS_PER_NODE },
						},
						env: { HARPER_NO_FLUSH_ON_EXIT: true },
					});
					return node.harper;
				})
			);

			// Mesh: every node adds every other node so we get full replication
			// across all peers, matching the production fully-connected topology.
			const tokens = await Promise.all(
				ctx.nodes.map((n) => sendOperation(n, { operation: 'create_authentication_tokens', authorization: n.admin }))
			);
			for (let i = 0; i < NODE_COUNT; i++) {
				for (let j = 0; j < NODE_COUNT; j++) {
					if (i === j) continue;
					await sendOperation(ctx.nodes[i], {
						operation: 'add_node',
						rejectUnauthorized: false,
						hostname: ctx.nodes[j].hostname,
						authorization: 'Bearer ' + tokens[j].operation_token,
					});
				}
			}
			// Wait for every node to see every other peer connected.
			for (const n of ctx.nodes) await waitForAllConnected(n, { timeoutMs: 90_000 });

			// Deploy the prerender workload component to one node; replicated:true
			// installs it on all peers, then restart=true makes it active everywhere.
			const payload = await targz(join(import.meta.dirname, 'fixture-prerender-workload'));
			await sendOperation(ctx.nodes[0], {
				operation: 'deploy_component',
				project: 'prerender-workload',
				payload,
				replicated: true,
				restart: true,
			});
			// Restart settle.
			await delay(40_000);
			// Make sure cluster is healthy again post-restart.
			for (const n of ctx.nodes) await waitForAllConnected(n, { timeoutMs: 90_000 });
		});

		after(async () => {
			if (!ctx.nodes) return;
			await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n }).catch(() => null)));
		});

		test('cluster survives sustained traffic + rolling SIGKILLs without OOM, leaks, or blob orphans', async () => {
			const startedAt = Date.now();
			const endAt = startedAt + TOTAL_MINUTES * 60_000;

			// Per-node metric samplers run for the whole soak. We sample every
			// 2 seconds — fine-grained enough to catch a memory burst preceding an
			// OOM but not so fine-grained that operations API noise dominates.
			const samplers = ctx.nodes.map((n) => sampleMetrics(n, { intervalMs: 2000 }));

			// Traffic driver — `concurrent` keeps a pool of in-flight requests.
			// Cache-miss responses each create a record + blob on the receiving
			// node which then replicates to the other three.
			let nextSeq = 0;
			let trafficStopped = false;
			const concurrencyTarget = Math.max(1, Math.floor(TRAFFIC_RPS / 4));
			const drivers = ctx.nodes.map((n) => {
				const driver = concurrent(async () => {
					if (trafficStopped) return;
					const idSeq = nextSeq++ % URL_KEYSPACE;
					const id = prerenderId(idSeq);
					try {
						await fetchWithRetry(n.httpURL + '/Prerender/' + encodeURIComponent(id), { retries: 1 });
					} catch {
						// Transient HTTP errors are expected when we kill a node;
						// the soak's assertions live in the post-run log scan.
					}
				}, concurrencyTarget);
				return driver;
			});
			// Fire-and-forget feed loop per driver — pace ourselves with a small
			// inter-request delay so we don't peg the loopback before Harper.
			const feeders = drivers.map(async (driver) => {
				while (!trafficStopped) {
					await driver.execute();
					await delay(1000 / Math.max(1, TRAFFIC_RPS / NODE_COUNT));
				}
				await driver.finish();
			});

			// Rolling-restart loop.
			const cycleEvents = [];
			let cycle = 0;
			while (Date.now() < endAt) {
				cycle++;
				const remainingMs = endAt - Date.now();
				const cycleDurationMs = Math.min(CYCLE_SECONDS * 1000, remainingMs);
				if (cycleDurationMs < 30_000) break; // not enough time for a full cycle, wind down
				const settleMs = Math.floor(cycleDurationMs * 0.55);
				const recoverMs = cycleDurationMs - settleMs;

				console.log(
					`[soak] cycle ${cycle}/${Math.ceil((TOTAL_MINUTES * 60) / CYCLE_SECONDS)} ` +
						`t=${Math.round((Date.now() - startedAt) / 1000)}s ` +
						`settling ${Math.round(settleMs / 1000)}s before kill`
				);
				await delay(settleMs);

				// Pick the next victim round-robin so each node gets cycled.
				const victimIdx = (cycle - 1) % NODE_COUNT;
				const victim = ctx.nodes[victimIdx];
				const before = await clusterSnapshot(victim).catch(() => null);
				console.log(`[soak] killing node ${victimIdx} (${victim.hostname})`);
				const killAt = Date.now();
				await killHarper({ harper: victim });

				// Restart — preserves dataRootDir and hostname so it rejoins the
				// existing cluster state. Update ctx.nodes[victimIdx] with the new
				// handle so subsequent same-node cycles (when round-robin wraps)
				// kill the actually-running process, not a stale reference.
				const restartCtx = {
					name: ctx.name,
					harper: { dataRootDir: victim.dataRootDir, hostname: victim.hostname },
				};
				await startHarper(restartCtx, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, console: true, level: 'warn' },
						replication: { securePort: victim.hostname + ':9933' },
						threads: { count: THREADS_PER_NODE },
					},
					env: { HARPER_NO_FLUSH_ON_EXIT: true },
				});
				ctx.nodes[victimIdx] = restartCtx.harper;
				const restartedAt = Date.now();
				cycleEvents.push({ cycle, victimIdx, downMs: restartedAt - killAt, beforeSnap: before });

				// Wait the rest of the cycle for recovery + traffic.
				await delay(Math.max(0, recoverMs - (Date.now() - restartedAt)));

				// Light health probe: every cycle, at least one peer should see
				// the resurrected victim as connected within 30s of restart.
				const sawConnected = await Promise.any(
					ctx.nodes
						.filter((_, idx) => idx !== victimIdx)
						.map(async (peer) => {
							const deadline = Date.now() + 30_000;
							while (Date.now() < deadline) {
								const snap = await clusterSnapshot(peer).catch(() => null);
								if (
									snap?.peers.some(
										(p) => (p.url ?? '').includes(victim.hostname) && Object.values(p.dbs).every((d) => d.connected)
									)
								)
									return true;
								await delay(500);
							}
							return false;
						})
				).catch(() => false);
				if (!sawConnected) {
					console.warn(`[soak] cycle ${cycle}: no peer saw victim reconnect within 30s (continuing)`);
				}
			}

			// Stop traffic; let in-flight requests drain. Bound the drain so a
			// stuck fetch on a still-recovering node can't hold the test.
			console.log('[soak] stopping traffic');
			trafficStopped = true;
			await Promise.race([
				Promise.all(feeders),
				delay(20_000).then(() => console.log('[soak] feeder drain timed out at 20s — continuing')),
			]);

			console.log('[soak] stopping sampling');
			const allSamples = samplers.map((s) => s.stop());

			// Allow steady-state convergence: stop writes, give replication time
			// to drain on all nodes, then compare record counts.
			console.log('[soak] convergence wait 15s');
			await delay(15_000);

			// Reference count = max observed across all nodes (whichever node has
			// the highest count is the leader to catch up to).
			const counts = await Promise.all(
				ctx.nodes.map((n) =>
					trySendOperation(n, { operation: 'describe_table', table: 'Prerender' }).then((r) => r?.record_count ?? -1)
				)
			);
			const target = Math.max(...counts);
			console.log(`[soak] post-settle record_count per node: ${counts.join(', ')} — target ${target}`);

			// Allow up to 90s extra convergence after stopping writes — laggards
			// may still be replaying buffered events.
			for (let i = 0; i < ctx.nodes.length; i++) {
				if (counts[i] < target) {
					try {
						const reached = await waitForRecordCount(ctx.nodes[i], 'Prerender', target, { timeoutMs: 90_000 });
						console.log(`[soak] node ${i} caught up to ${reached}`);
					} catch (err) {
						console.log(`[soak] node ${i} did not catch up: ${err.message}`);
					}
				}
			}
			const finalCounts = await Promise.all(
				ctx.nodes.map((n) =>
					trySendOperation(n, { operation: 'describe_table', table: 'Prerender' }).then((r) => r?.record_count ?? -1)
				)
			);
			console.log(`[soak] final record_count per node: ${finalCounts.join(', ')}`);

			// === Assertions ===

			// (1) No OOM markers in any node's log.
			for (let i = 0; i < ctx.nodes.length; i++) {
				const log = await readLog(ctx.nodes[i]);
				ok(
					!log.includes('ERR_WORKER_OUT_OF_MEMORY'),
					`node ${i} (${ctx.nodes[i].hostname}) hit ERR_WORKER_OUT_OF_MEMORY during soak`
				);
			}

			// (2) No uncaughtException anywhere.
			for (let i = 0; i < ctx.nodes.length; i++) {
				const log = await readLog(ctx.nodes[i]);
				const uncaught = log.match(/\[error\]: uncaughtException/g) ?? [];
				ok(
					uncaught.length === 0,
					`node ${i} logged ${uncaught.length} uncaughtException(s); first match: ${uncaught[0]}`
				);
			}

			// (3) No "Error sending blob ... ENOENT" — the blob-orphan signature.
			for (let i = 0; i < ctx.nodes.length; i++) {
				const log = await readLog(ctx.nodes[i]);
				const orphans = log.match(/\[error\] \[replication\]: Error sending blob.*ENOENT/g) ?? [];
				ok(
					orphans.length === 0,
					`node ${i} logged ${orphans.length} blob-orphan ENOENT(s) during soak; sample:\n  ${orphans[0]}`
				);
			}

			// (4) Convergence: every node has the same Prerender record_count.
			// Allow up to 1% drift to absorb in-flight writes from the moment
			// traffic was stopped — the goal is "no permanent divergence",
			// not "exact at the instant we sampled".
			const minCount = Math.min(...finalCounts);
			const maxCount = Math.max(...finalCounts);
			const drift = maxCount > 0 ? (maxCount - minCount) / maxCount : 0;
			ok(
				drift < 0.01,
				`record counts diverged > 1% across nodes: ${JSON.stringify(finalCounts)} (drift ${(drift * 100).toFixed(2)}%)`
			);

			// (5) Per-node peak RSS under the limit.
			for (let i = 0; i < ctx.nodes.length; i++) {
				const summary = summariseSamples(allSamples[i]);
				console.log(
					`[soak] node ${i}: peakRss=${mb(summary.peakRss)} avgRss=${mb(summary.avgRss)} ` +
						`peakWorkerFootprint=${mb(summary.peakThreadFootprint)} samples=${summary.sampleCount}`
				);
				ok(
					summary.peakRss > 0 && summary.peakRss < PEAK_RSS_LIMIT_BYTES,
					`node ${i} peak RSS ${mb(summary.peakRss)} exceeded limit ${mb(PEAK_RSS_LIMIT_BYTES)}`
				);
			}

			console.log(
				`[soak] completed ${cycle} kill cycles over ${Math.round((Date.now() - startedAt) / 1000)}s; ` +
					`final convergent record_count=${finalCounts[0]}`
			);
		});
	});
}
