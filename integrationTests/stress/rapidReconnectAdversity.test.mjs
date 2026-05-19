/**
 * Rapid-reconnect adversity test — exercises the WS connect/disconnect
 * paths in replicationConnection.ts at a much higher rate than the soak
 * test, surfacing listener leaks, retry storms, and the (recently fixed)
 * "schemaUpdateListener still pinned to global emitter after WS close"
 * class of bug (harper-pro PR #161/#173).
 *
 * Originally scoped as a tc/netem + iptables network-adversity test, but
 * those require NET_ADMIN, which we don't reliably have outside CI's
 * `ubuntu-latest` runner. Forced WS closures via fast kill+restart cycles
 * cover the same surface — reconnect, subscription resubscribe, blob
 * stream resumption, listener cleanup — without needing root.
 *
 * Setup: 3 nodes, mesh, prerender workload.
 *
 * Sequence:
 *   - Steady write traffic on all nodes.
 *   - Every CYCLE_SECONDS (default 15s), pick a random node, kill+restart
 *     it. Wait the rest of the cycle, repeat.
 *   - Total duration HARPER_STRESS_ADVERSITY_MINUTES (default 10 locally /
 *     30 in workflow).
 *
 * Assertions:
 *   1. MaxListenersExceededWarning never appears (the recent fixes were
 *      explicitly about not leaking schemaUpdateListener / dropDatabase
 *      listeners on `databaseEventsEmitter` after WS close).
 *   2. No `uncaughtException`.
 *   3. No `ERR_WORKER_OUT_OF_MEMORY`.
 *   4. Final convergence: every node has equal Prerender record_count.
 *
 * Run:
 *   HARPER_RUN_STRESS_TESTS=1 HARPER_STRESS_ADVERSITY_MINUTES=5 \
 *     npm run test:integration -- \
 *       integrationTests/stress/rapidReconnectAdversity.test.mjs
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
	suite('Rapid reconnect adversity (skipped)', () => {
		test('skipped — set HARPER_RUN_STRESS_TESTS=1 to enable', { skip: true }, () => {});
	});
} else {
	const NODE_COUNT = 3;
	const THREADS_PER_NODE = 2;
	const TOTAL_MINUTES = Number(process.env.HARPER_STRESS_ADVERSITY_MINUTES ?? 10);
	const CYCLE_SECONDS = Number(process.env.HARPER_STRESS_ADVERSITY_CYCLE_SECONDS ?? 15);
	const TRAFFIC_RPS = Number(process.env.HARPER_STRESS_ADVERSITY_RPS ?? 10);
	const SUITE_TIMEOUT_MS = (TOTAL_MINUTES + 4) * 60_000;

	suite('Rapid reconnect adversity', { timeout: SUITE_TIMEOUT_MS }, (ctx) => {
		before(async () => {
			const cfg = (host) => ({
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, console: true, level: 'debug' },
				replication: { securePort: host + ':9933' },
				threads: { count: THREADS_PER_NODE },
			});
			ctx.nodes = await Promise.all(
				Array.from({ length: NODE_COUNT }).map(async () => {
					const node = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
					await startHarper(node, { config: cfg(node.harper.hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
					return node.harper;
				})
			);
			// Mesh
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
			for (const n of ctx.nodes) await waitForAllConnected(n, { timeoutMs: 60_000 });

			const payload = await targz(join(import.meta.dirname, 'fixture-prerender-workload'));
			await sendOperation(ctx.nodes[0], {
				operation: 'deploy_component',
				project: 'prerender-workload',
				payload,
				replicated: true,
				restart: true,
			});
			await delay(35_000);
			for (const n of ctx.nodes) await waitForAllConnected(n, { timeoutMs: 60_000 });
		});

		after(async () => {
			if (!ctx.nodes) return;
			await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n }).catch(() => null)));
		});

		test('rapid kill+restart cycles surface no listener leaks or uncaughts', async () => {
			const startedAt = Date.now();
			const endAt = startedAt + TOTAL_MINUTES * 60_000;

			// Sustained but light traffic from all nodes simultaneously.
			let stop = false;
			let seq = 0;
			const drivers = ctx.nodes.map((n) =>
				concurrent(
					async () => {
						if (stop) return;
						const id = prerenderId(seq++ % 1500);
						try {
							await fetchWithRetry(n.httpURL + '/Prerender/' + encodeURIComponent(id), { retries: 1 });
						} catch {
							/* expected during kill windows */
						}
					},
					Math.max(1, Math.floor(TRAFFIC_RPS / NODE_COUNT))
				)
			);
			const feeders = drivers.map(async (driver) => {
				while (!stop) {
					await driver.execute();
					await delay(1000 / Math.max(1, TRAFFIC_RPS / NODE_COUNT));
				}
				await driver.finish();
			});

			let cycle = 0;
			while (Date.now() < endAt) {
				cycle++;
				const idx = (cycle - 1) % NODE_COUNT;
				const victim = ctx.nodes[idx];
				console.log(
					`[adversity] cycle ${cycle} t=${Math.round((Date.now() - startedAt) / 1000)}s ` +
						`killing node ${idx} (${victim.hostname})`
				);
				await killHarper({ harper: victim });
				await startHarper(
					{ name: ctx.name, harper: { dataRootDir: victim.dataRootDir, hostname: victim.hostname } },
					{
						config: {
							analytics: { aggregatePeriod: -1 },
							logging: { colors: false, console: true, level: 'debug' },
							replication: { securePort: victim.hostname + ':9933' },
							threads: { count: THREADS_PER_NODE },
						},
						env: { HARPER_NO_FLUSH_ON_EXIT: true },
					}
				);
				// Wait the rest of the cycle period before the next kill.
				const elapsed = (Date.now() - startedAt) / 1000;
				const nextCycleAt = cycle * CYCLE_SECONDS;
				const sleepMs = Math.max(2000, (nextCycleAt - elapsed) * 1000);
				if (Date.now() + sleepMs > endAt) break;
				await delay(sleepMs);
			}

			stop = true;
			await Promise.all(feeders);

			// Settle.
			await delay(20_000);

			// === Assertions ===

			const logs = await Promise.all(ctx.nodes.map((n) => readLog(n)));
			for (let i = 0; i < logs.length; i++) {
				const log = logs[i];
				const node = ctx.nodes[i];

				// (1) MaxListenersExceededWarning — the prior listener-leak fixes
				//     in main were specifically about not pinning listeners on
				//     databaseEventsEmitter across WS reconnects.
				ok(
					!log.includes('MaxListenersExceededWarning'),
					`node ${i} (${node.hostname}) logged MaxListenersExceededWarning during reconnect cycles`
				);

				// (2) No uncaughtException
				const uncaught = log.match(/\[error\]: uncaughtException/g) ?? [];
				ok(uncaught.length === 0, `node ${i} logged ${uncaught.length} uncaughtException; first: ${uncaught[0]}`);

				// (3) No OOM
				ok(!log.includes('ERR_WORKER_OUT_OF_MEMORY'), `node ${i} logged ERR_WORKER_OUT_OF_MEMORY`);
			}

			// (4) Convergence
			const counts = await Promise.all(
				ctx.nodes.map((n) =>
					trySendOperation(n, { operation: 'describe_table', table: 'Prerender' }).then((r) => r?.record_count ?? -1)
				)
			);
			const uniq = new Set(counts);
			console.log(`[adversity] cycles=${cycle} final record_count=${counts.join(', ')}`);
			ok(uniq.size === 1, `record_count diverged across nodes after ${cycle} kill cycles: ${JSON.stringify(counts)}`);
		});
	});
}
