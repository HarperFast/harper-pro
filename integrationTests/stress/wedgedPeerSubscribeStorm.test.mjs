/**
 * Wedged-peer subscribe-storm + subscription-reliability soak.
 *
 * Background (eh-prod.gend us-west-1, 2026-06-11): a node with a peer stuck
 * `connected:false` past the 30 s wedge threshold drove the wedge reconcile to
 * re-issue `forceResubscribe` every tick. That one-shot intent leaked into the
 * persistent `onUpdatedTable`/`onRemovedDB` listeners `forEachReplicatedDatabase`
 * registers, so every later schema event re-subscribed the dead peer — a
 * 100%-CPU `Setting up subscription with leader …` log-flood that also grew an
 * unbounded `subscribe-to-node` postMessage backlog → V8 heap OOM → crash loop.
 * The blow-up scaled with (a) how many DATABASES exist (the reconcile iterates
 * `Object.getOwnPropertyNames(databases)`) and (b) how often `updateTable` fires
 * (schema churn). The fix re-dispatches only the existing `connected:false`
 * entries from the reconcile and never re-drives via `onNodeUpdate`, so the
 * `Setting up subscription with leader` line stays rare regardless of how long a
 * peer is wedged.
 *
 * The other half of the same area is reliability: after a restart or a
 * remove/re-add, subscriptions must reliably re-establish (cf. the #289
 * "subscription silently never reconnects after restart" stuck state). A single
 * heal cycle can't catch a per-cycle accumulation (leaked listener / stale
 * connectionReplicationMap entry) that only arms the storm on cycle N, so we
 * loop.
 *
 * Scenario:
 *  1. (SURVIVORS + 1)-node mesh, MANY databases (the fan-out dimension).
 *  2. Permanently kill ONE peer — it stays `connected:false`/desired forever,
 *     so the wedge reconcile keeps targeting it for the whole run.
 *  3. For CYCLES iterations, with the dead peer still wedged:
 *       - schema churn (create+drop a table) → fires `updateTable`,
 *       - steady writes to a churn table,
 *       - alternate a reliability action: restart a survivor, or
 *         remove_node + add_node a survivor,
 *       - assert the surviving mesh fully reconnects.
 *  4. Dwell long enough that many 30 s reconcile windows elapse for the dead peer.
 *
 * Assertions (per survivor, after the soak):
 *  1. `Setting up subscription with leader` count < SUBSCRIBE_CAP. This is the
 *     precise spin gate — the bug produces this line millions of times; a healthy
 *     node logs it only on genuine (re)subscribes (a few per DB per reconnect).
 *  2. Zero `MaxListenersExceededWarning` (listener leak across cycles).
 *  3. Zero `uncaughtException`, zero OOM markers.
 *  4. The surviving mesh is fully connected and the churn table has converged.
 *  5. Peak RSS stays under RSS_CAP_MB.
 *
 * Run locally (small, ~3–5 min):
 *   HARPER_RUN_STRESS_TESTS=1 HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR=~/dev/tmp \
 *     npm run test:integration -- integrationTests/stress/wedgedPeerSubscribeStorm.test.mjs
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, teardownHarper, killHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	stressEnabled,
	sendOperation,
	trySendOperation,
	clusterSnapshot,
	readLog,
	sampleMetrics,
	summariseSamples,
	mb,
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
	suite('Wedged-peer subscribe-storm (skipped)', () => {
		test('skipped — set HARPER_RUN_STRESS_TESTS=1 to enable', { skip: true }, () => {});
	});
} else {
	const THREADS_PER_NODE = 4;
	const SURVIVORS = Number(process.env.HARPER_STRESS_WEDGE_SURVIVORS ?? 4);
	const DBS = Number(process.env.HARPER_STRESS_WEDGE_DBS ?? 20);
	const CYCLES = Number(process.env.HARPER_STRESS_WEDGE_CYCLES ?? 6);
	// Per-cycle floor dwell so the dead peer accumulates many >30 s reconcile windows
	// across the run (the wedge reconcile only forceResubscribes once disconnectedAt
	// exceeds the 30 s threshold, then re-evaluates every 5 s).
	const DWELL_MS = Number(process.env.HARPER_STRESS_WEDGE_DWELL_MS ?? 8000);
	// Spin gate: with the fix, `Setting up subscription with leader` is logged only on
	// genuine (re)subscribes — roughly DBS per node per reconnect. The bug logs it
	// millions of times, so any ceiling well above the legitimate count discriminates.
	const SUBSCRIBE_CAP = Number(process.env.HARPER_STRESS_WEDGE_SUBSCRIBE_CAP ?? Math.max(3000, DBS * CYCLES * 30));
	const RSS_CAP_MB = Number(process.env.HARPER_STRESS_WEDGE_RSS_CAP_MB ?? 1500);
	const RECONNECT_TIMEOUT_MS = Number(process.env.HARPER_STRESS_WEDGE_RECONNECT_TIMEOUT_MS ?? 90_000);
	const CHURN_DB = 'wedge_churn';
	const CHURN_TABLE = 'Events';
	const SUITE_TIMEOUT_MS = (CYCLES * 150 + 600) * 1000;

	const baseConfig = (host) => ({
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, console: true, level: 'warn' },
		replication: { securePort: host + ':9933' },
		threads: { count: THREADS_PER_NODE },
	});

	// Like waitForAllConnected, but ignores the permanently-dead peer (which is
	// expected to stay connected:false). `expectedPeers` is the number of OTHER survivors
	// this node must show connected — required so a survivor that silently dropped out of
	// cluster_status (e.g. remove_node succeeded but the re-add only partially reconnected)
	// fails the gate instead of passing on a partial mesh.
	async function waitForSurvivorMesh(node, deadHostname, { expectedPeers, timeoutMs = RECONNECT_TIMEOUT_MS } = {}) {
		const deadline = Date.now() + timeoutMs;
		let last;
		while (Date.now() < deadline) {
			last = await clusterSnapshot(node).catch(() => null);
			if (last) {
				const survivors = last.peers.filter((p) => !(p.url ?? '').includes(deadHostname) && p.name !== deadHostname);
				// Require each peer to have re-opened all of its db sockets (>= the DBS+1 databases we
				// created), not just an empty set: right after a reconnect there's a window where the
				// control connection is up but `dbs` is still `{}`, and `[].every()` is vacuously true.
				if (
					survivors.length >= expectedPeers &&
					survivors.every((p) => {
						const dbs = Object.values(p.dbs);
						return dbs.length >= DBS + 1 && dbs.every((d) => d.connected);
					})
				)
					return last;
			}
			await delay(500);
		}
		throw new Error(
			`waitForSurvivorMesh timed out on ${node.hostname} (need ${expectedPeers} connected survivor peers); final: ${JSON.stringify(last)}`
		);
	}

	suite('Wedged-peer subscribe-storm', { timeout: SUITE_TIMEOUT_MS }, (ctx) => {
		before(async () => {
			ctx.nodes = await Promise.all(
				Array.from({ length: SURVIVORS + 1 }).map(async () => {
					const node = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
					await startHarper(node, { config: baseConfig(node.harper.hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
					return node.harper;
				})
			);

			// Mesh: every other node add_nodes node[0] (the leader/bootstrap).
			const tokenResp = await sendOperation(ctx.nodes[0], {
				operation: 'create_authentication_tokens',
				authorization: ctx.nodes[0].admin,
			});
			ctx.leaderToken = 'Bearer ' + tokenResp.operation_token;
			for (let i = 1; i < ctx.nodes.length; i++) {
				await sendOperation(ctx.nodes[i], {
					operation: 'add_node',
					rejectUnauthorized: false,
					hostname: ctx.nodes[0].hostname,
					authorization: ctx.leaderToken,
				});
			}
			for (let i = 1; i < ctx.nodes.length; i++) {
				// All SURVIVORS+1 nodes are still up here (doomed not yet killed); each must see the
				// other SURVIVORS connected.
				await waitForSurvivorMesh(ctx.nodes[i], '__none__', { expectedPeers: SURVIVORS, timeoutMs: 90_000 });
			}

			// The fan-out dimension: many databases, each with a table, plus the churn table.
			for (let i = 0; i < DBS; i++) {
				await sendOperation(ctx.nodes[0], { operation: 'create_database', database: `wedge_db_${i}` });
				await sendOperation(ctx.nodes[0], {
					operation: 'create_table',
					database: `wedge_db_${i}`,
					table: 'T',
					primary_key: 'id',
					attributes: [{ name: 'id', type: 'ID' }],
				});
			}
			await sendOperation(ctx.nodes[0], { operation: 'create_database', database: CHURN_DB });
			await sendOperation(ctx.nodes[0], {
				operation: 'create_table',
				database: CHURN_DB,
				table: CHURN_TABLE,
				primary_key: 'id',
				attributes: [{ name: 'id', type: 'ID' }],
			});

			// Let the schema replicate so every survivor carries all DBS+1 databases. Wait per-node
			// in parallel (each with its own deadline) and throw if any node fails to settle — a
			// shared sequential deadline would starve later nodes, and a silent exit would let the
			// test continue on an under-replicated cluster.
			const expected = DBS + 1;
			await Promise.all(
				ctx.nodes.slice(1).map(async (node) => {
					const settleDeadline = Date.now() + 60_000;
					while (Date.now() < settleDeadline) {
						const all = await trySendOperation(node, { operation: 'describe_all' });
						if (all && Object.keys(all).length >= expected) return;
						await delay(1000);
					}
					throw new Error(`Node ${node.hostname} did not replicate ${expected} databases within 60s`);
				})
			);
		});

		after(async () => {
			if (!ctx.nodes) return;
			await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n }).catch(() => null)));
		});

		test('dead peer stays wedged without a subscribe storm while survivors restart/re-add reliably', async () => {
			// node[0] is the bootstrap/leader; the LAST node is the doomed peer.
			const leader = ctx.nodes[0];
			const doomed = ctx.nodes[ctx.nodes.length - 1];
			const survivors = ctx.nodes.slice(0, ctx.nodes.length - 1);
			const deadHostname = doomed.hostname;
			// Every survivor incarnation we ever start — a restart writes to a fresh log dir
			// (HARPER_INTEGRATION_TEST_LOG_DIR), so the end-of-run log scan must read all of them,
			// not just the latest handle, or an earlier incarnation's storm/leak/OOM is missed.
			// Snapshots, not live handles: a restart updates the live node object in place (below),
			// so we must capture each incarnation's log location at the time it was running.
			const logHandle = (n) => ({ logDir: n.logDir, dataRootDir: n.dataRootDir, hostname: n.hostname });
			const incarnations = survivors.map(logHandle);

			const samplers = survivors.map((n) => sampleMetrics(n, { intervalMs: 2000 }));

			// Permanently kill the doomed peer — it remains in hdb_nodes (desired) on
			// every survivor, so it is a perpetual wedge-reconcile target.
			console.log(`[wedge] permanently killing doomed peer ${deadHostname}`);
			await killHarper({ harper: doomed });

			let writes = 0;
			for (let cycle = 0; cycle < CYCLES; cycle++) {
				// Schema churn → fires updateTable across the cluster (drives the leaked-listener path).
				// These run against the bootstrap leader, which is never killed/removed, so they must
				// succeed — let any failure throw and fail the test rather than masking a schema/ingest
				// regression behind a "pass".
				const churnDb = `wedge_db_${cycle % DBS}`;
				const churnTable = `Cycle_${cycle}`;
				await sendOperation(leader, {
					operation: 'create_table',
					database: churnDb,
					table: churnTable,
					primary_key: 'id',
					attributes: [{ name: 'id', type: 'ID' }],
				});
				if (cycle > 0) {
					await sendOperation(leader, {
						operation: 'drop_table',
						database: `wedge_db_${(cycle - 1) % DBS}`,
						table: `Cycle_${cycle - 1}`,
					});
				}

				// Steady writes to the churn table for convergence.
				const batch = Array.from({ length: 50 }, () => ({ id: `r${writes++}` }));
				await sendOperation(leader, {
					operation: 'insert',
					database: CHURN_DB,
					table: CHURN_TABLE,
					records: batch,
				});

				// Alternate the reliability action: even = restart, odd = remove/re-add.
				// Rotate the target across survivors[1..] (never the bootstrap leader).
				const target = survivors[1 + (cycle % (survivors.length - 1))];
				if (cycle % 2 === 0) {
					console.log(`[wedge] cycle ${cycle}: restarting survivor ${target.hostname}`);
					await killHarper({ harper: target });
					await delay(1000);
					const restartCtx = { name: ctx.name, harper: { dataRootDir: target.dataRootDir, hostname: target.hostname } };
					await startHarper(restartCtx, { config: baseConfig(target.hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
					// Record the new incarnation's log location for the end-of-run scan, then update the
					// SAME `target` object in place. ctx.nodes/survivors and the metrics sampler all hold
					// `target`, so Object.assign transitions them to the restarted node's port/creds/log
					// without losing references (a fresh object would leave the sampler polling the dead one).
					incarnations.push(logHandle(restartCtx.harper));
					Object.assign(target, restartCtx.harper);
				} else {
					console.log(`[wedge] cycle ${cycle}: remove_node + add_node ${target.hostname}`);
					// remove_node/add_node are the reliability operations under test — if either fails,
					// that IS the regression, so let it throw rather than swallowing it.
					await sendOperation(leader, { operation: 'remove_node', hostname: target.hostname });
					await delay(2000);
					await sendOperation(target, {
						operation: 'add_node',
						rejectUnauthorized: false,
						hostname: leader.hostname,
						authorization: ctx.leaderToken,
					});
				}

				// Reliability gate: the surviving mesh must fully reconnect this cycle.
				for (const s of survivors) {
					await waitForSurvivorMesh(s, deadHostname, { expectedPeers: SURVIVORS - 1 });
				}
				// Dwell so the dead peer crosses/repeats the 30 s wedge window under churn.
				await delay(DWELL_MS);
				console.log(`[wedge] cycle ${cycle} done; writes=${writes}`);
			}

			const summaries = samplers.map((s) => summariseSamples(s.stop()));

			const subscribeRe = /Setting up subscription with leader/g;
			const maxListenersRe = /MaxListenersExceededWarning/g;
			const uncaughtRe = /\[error\]: uncaughtException/g;
			const oomRe = /JavaScript heap out of memory|FATAL ERROR.*Allocation failed|ERR_WORKER_OUT_OF_MEMORY/g;

			// Scan every incarnation's log, deduped by the RESOLVED log-file path (matching readLog's
			// resolution) so incarnations with different logDir/dataRootDir combinations that point at
			// the same physical file — e.g. restarts without HARPER_INTEGRATION_TEST_LOG_DIR share
			// dataRootDir/log/hdb.log — aren't scanned twice.
			const seenLogPaths = new Set();
			const scanned = incarnations.filter((n) => {
				const path = n.logDir ? join(n.logDir, 'hdb.log') : n.dataRootDir ? join(n.dataRootDir, 'log', 'hdb.log') : null;
				if (!path || seenLogPaths.has(path)) return false;
				seenLogPaths.add(path);
				return true;
			});
			const logs = await Promise.all(scanned.map((n) => readLog(n)));
			for (let i = 0; i < scanned.length; i++) {
				const log = logs[i];
				const host = scanned[i].hostname;
				const subscribeCount = (log.match(subscribeRe) ?? []).length;
				const maxListeners = (log.match(maxListenersRe) ?? []).length;
				const uncaught = (log.match(uncaughtRe) ?? []).length;
				const oom = (log.match(oomRe) ?? []).length;
				console.log(
					`[wedge] incarnation ${host}: subscribeLines=${subscribeCount} maxListeners=${maxListeners} ` +
						`uncaught=${uncaught} oom=${oom}`
				);
				// (1) The spin gate — a storm blows the cap within a single incarnation's log.
				ok(
					subscribeCount < SUBSCRIBE_CAP,
					`${host} logged "Setting up subscription with leader" ${subscribeCount} times (cap ${SUBSCRIBE_CAP}) — ` +
						`indicates the wedge-reconcile re-subscribe storm`
				);
				// (2) Listener leak across cycles.
				ok(maxListeners === 0, `${host} logged ${maxListeners} MaxListenersExceededWarning`);
				// (3) No crash markers.
				ok(uncaught === 0, `${host} logged ${uncaught} uncaughtException`);
				ok(oom === 0, `${host} logged ${oom} OOM markers`);
			}

			// (5) Memory cap — samplers track each live survivor by its stable hostname:port,
			// so they keep sampling across restarts.
			for (let i = 0; i < survivors.length; i++) {
				const peakMb = summaries[i].peakRss / 1024 / 1024;
				console.log(`[wedge] ${survivors[i].hostname}: peakRss=${mb(summaries[i].peakRss)}`);
				ok(peakMb < RSS_CAP_MB, `${survivors[i].hostname} peak RSS ${peakMb.toFixed(0)} MB exceeded cap ${RSS_CAP_MB} MB`);
			}

			// (4) Final mesh + convergence among survivors. Poll for convergence rather than
			// asserting immediately — under CI CPU/IO load a freshly re-added survivor may need a
			// few seconds beyond the per-cycle dwell to drain its replication backlog.
			for (const s of survivors) await waitForSurvivorMesh(s, deadHostname, { expectedPeers: SURVIVORS - 1 });
			const convergeDeadline = Date.now() + RECONNECT_TIMEOUT_MS;
			let counts = [];
			let converged = false;
			while (Date.now() < convergeDeadline) {
				counts = await Promise.all(
					survivors.map((n) =>
						sendOperation(n, { operation: 'describe_table', database: CHURN_DB, table: CHURN_TABLE })
							.then((r) => r.record_count ?? -1)
							.catch(() => -1)
					)
				);
				if (counts.every((c) => c === writes)) {
					converged = true;
					break;
				}
				await delay(1000);
			}
			console.log(`[wedge] final churn counts: ${JSON.stringify(counts)} (wrote ${writes}) converged=${converged}`);
			ok(
				converged,
				`survivors did not converge on ${CHURN_DB}.${CHURN_TABLE} at ${writes} records: ${JSON.stringify(counts)}`
			);
		});
	});
}
