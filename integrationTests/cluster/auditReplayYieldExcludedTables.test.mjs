/**
 * QA-690: regression anchor for harper-pro#535 ("Audit replay loop starves the event
 * loop on long not-subscribed-table runs"), fixed by 70ec9485
 * (fix(replication): yield the audit replay loop on not-subscribed table skips (#536)).
 *
 * qa522-audit-replay-yield-live.test.mjs already exercises this fix, but via a
 * synthetic "dropped table" trick (create+drop a table, restart the sender so its
 * fresh table registry has no entry for it) — its own comments explain that was a
 * deliberate workaround after the *actual* production mechanism (per-route
 * `excludeTables` / `replication.databases` scoping) hit a separate, unrelated bug
 * when driven via `add_node`'s `subscriptions` list. This test exercises the real
 * "not subscribed" mechanism instead — static-route `excludeTables`, exactly as
 * documented in excludeTablesReplication.test.mjs and selectiveTableSubscription.test.mjs
 * — and additionally interleaves the excluded run with subscribed-table traffic
 * ("small amount of subscribed-table traffic behind it") and runs at larger scale
 * (60k excluded rows across two runs, vs qa522's single 50k run), which is the
 * "multi-run interleaving" + "larger scale" corner flagged as not-yet-covered.
 *
 * Shape:
 *   - A and B share a static route on database 'data' with `excludeTables: ['excluded']`
 *     in both directions (B never subscribes to 'excluded'). 'keep' is NOT excluded.
 *   - B is taken offline. While offline, A writes two 30k-row bursts to 'excluded'
 *     with a handful of 'keep' rows interleaved between and after them — so B's
 *     persisted resume cursor (captured before any of this existed) must walk
 *     forward through two long not-subscribed-table skip runs to reach the
 *     subscribed rows sitting behind them.
 *   - A is left at `threads.count: 1` so an external operationsAPI ping necessarily
 *     shares its single event loop with the replication send loop doing the replay.
 *   - B is restarted (same config + dataRootDir) and reconnects via the static route.
 *     While A replays the backlog to B, we poll A's operationsAPI on a short interval
 *     and track the max gap; a starved event loop (the pre-#536 bug) shows up as
 *     multi-second gaps.
 *
 * Precondition (hard-asserted, non-vacuous): after the run, 'excluded' row count on A
 * must equal the written total and on B must be exactly 0 — i.e. the skip run was
 * real and really was skipped, not just "nothing happened to replicate yet".
 *
 * Run:
 *   cd /home/kzyp/dev/harper-pro
 *   npm run test:integration -- \
 *     "integrationTests/cluster/auditReplayYieldExcludedTables.test.mjs"
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, killHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const DB = 'data';
const EXCLUDED_TABLE = 'excluded';
const KEEP_TABLE = 'keep';
const CHUNK_SIZE = 30000; // two chunks -> 60k excluded rows total ("tens of thousands", larger than qa522's single 50k run)
// Generous: production stalls were 11+ minutes. A local double-run 60k-entry skip
// walk should stay near-baseline (sub-second per ping) if the fix is doing its job;
// anything crossing this means the loop is not yielding like it should.
const PING_STALL_THRESHOLD_MS = 4000;
const CATCHUP_TIMEOUT_MS = 90000;

/** Time a single lightweight operationsAPI round-trip against `node`. */
async function pingOnce(node) {
	const t0 = Date.now();
	try {
		await sendOperation(node, { operation: 'system_information', attributes: ['memory'] });
		return Date.now() - t0;
	} catch {
		return Date.now() - t0; // a failed/slow round-trip is still a (large) latency sample
	}
}

/** Fire pings back-to-back against `node` until `stopFlag.stop` is set. Collects {t, rtt} samples. */
async function pingLoop(node, samples, stopFlag, intervalMs = 15) {
	while (!stopFlag.stop) {
		const rtt = await pingOnce(node);
		samples.push({ t: Date.now(), rtt });
		await delay(intervalMs);
	}
}

/** Poll cluster_status on `node` until every connection's database_sockets report connected. */
async function waitForConnected(node, maxMs = 60000) {
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline) {
		const status = await sendOperation(node, { operation: 'cluster_status' }).catch(() => null);
		if (
			status?.connections?.length > 0 &&
			status.connections.every((c) => c.database_sockets?.length > 0 && c.database_sockets.every((s) => s.connected))
		)
			return true;
		await delay(500);
	}
	return false;
}

async function countRows(node, table) {
	const rows = await sendOperation(node, { operation: 'sql', sql: `SELECT COUNT(*) AS c FROM ${DB}.${table}` }).catch(
		() => null
	);
	return rows?.[0]?.c ?? -1;
}

/** Poll search_by_id on `node` until every id in `ids` is found or the timeout elapses. Returns the still-missing ids. */
async function waitForIds(node, table, ids, maxMs) {
	const deadline = Date.now() + maxMs;
	let missing = new Set(ids);
	while (Date.now() < deadline && missing.size > 0) {
		const found = await sendOperation(node, {
			operation: 'search_by_id',
			database: DB,
			table,
			ids: [...missing],
			get_attributes: ['id'],
		}).catch(() => []);
		for (const r of found) missing.delete(r.id);
		if (missing.size > 0) await delay(300);
	}
	return [...missing];
}

function nodeConfig(hostname, peerHostname, { singleThread = false } = {}) {
	const excludeEntry = { database: DB, excludeTables: [EXCLUDED_TABLE] };
	const config = {
		analytics: { aggregatePeriod: -1 },
		// Deliberately NOT 'debug' — the bug's precondition is `logger.debug?.()`
		// evaluating to `undefined` at production log level.
		logging: { level: 'warn', colors: false, stdStreams: true, console: true },
		replication: {
			port: hostname + ':9933',
			securePort: null,
			routes: [
				{
					hostname: peerHostname,
					port: 9933,
					sendsTo: [excludeEntry],
					receivesFrom: [excludeEntry],
				},
			],
		},
	};
	if (singleThread) config.threads = { count: 1 };
	// Deliberately NOT HARPER_NO_FLUSH_ON_EXIT: we want clean, fully-flushed restarts so the
	// local crash-recovery WAL replay (a separate mechanism, harper-pro#1266) never fires and
	// competes with/masks the thing under test — the replication SEND loop's own skip-run walk.
	return { config };
}

suite('QA-690: audit replay loop yields on excludeTables skip run (harper-pro#535/#536)', { timeout: 600000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();
		ctx.hostnameA = hostnameA;
		ctx.hostnameB = hostnameB;

		const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
		const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };

		await Promise.all([
			startHarper(ctxA, nodeConfig(hostnameA, hostnameB, { singleThread: true })),
			startHarper(ctxB, nodeConfig(hostnameB, hostnameA)),
		]);

		ctx.nodeA = ctxA.harper;
		ctx.nodeB = ctxB.harper;

		// excludeTables affects schema propagation too — create both tables independently
		// on both nodes so 'excluded' isn't silently missing on one side.
		for (const node of [ctx.nodeA, ctx.nodeB]) {
			await sendOperation(node, { operation: 'create_table', database: DB, table: EXCLUDED_TABLE, primary_key: 'id' });
			await sendOperation(node, { operation: 'create_table', database: DB, table: KEEP_TABLE, primary_key: 'id' });
		}

		const connected = await waitForConnected(ctx.nodeB);
		ok(connected, 'B did not form a connected route to A');
		console.log('Cluster up — A:', ctx.nodeA.hostname, '(threads:1) B:', ctx.nodeB.hostname);
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }).catch(() => {}),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }).catch(() => {}),
		]);
	});

	test('sanity: keep-table replication is live before the excluded-table burst', async () => {
		const id = 'sanity-' + Date.now();
		await sendOperation(ctx.nodeA, { operation: 'upsert', database: DB, table: KEEP_TABLE, records: [{ id, value: 'v1' }] });
		const missing = await waitForIds(ctx.nodeB, KEEP_TABLE, [id], 20000);
		equal(missing.length, 0, 'keep-table record did not replicate A->B — route is not actually live');
		console.log('Sanity: keep-table replication confirmed live (A->B) over the excludeTables route');
	});

	test(
		'A stays responsive and keep-table rows behind two long excluded-table skip runs still arrive at B',
		async () => {
			// 1. Take B offline. Its persisted resume cursor is captured BEFORE any of the
			//    excluded/keep burst below exists, so on reconnect A's sender must walk
			//    forward through both skip runs to catch it up.
			const bHostname = ctx.nodeB.hostname;
			const bDataRootDir = ctx.nodeB.dataRootDir;
			await killHarper({ harper: ctx.nodeB });
			console.log('B killed (offline) — its resume cursor predates the burst below');

			// 2. While B is offline: two 30k-row excluded-table bursts, with keep-table rows
			//    interleaved between and after — subscribed traffic sitting behind (and between)
			//    long not-subscribed-table skip runs.
			const makeExcludedChunk = (prefix, n) =>
				Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, payload: 'x'.repeat(32) }));
			const keepInterleaved = Array.from({ length: 5 }, (_, i) => ({ id: `keep-interleaved-${i}`, value: 'behind-run-1' }));
			const keepAfter = Array.from({ length: 5 }, (_, i) => ({ id: `keep-after-${i}`, value: 'behind-run-2' }));

			const writeStart = Date.now();
			await sendOperation(ctx.nodeA, {
				operation: 'upsert',
				database: DB,
				table: EXCLUDED_TABLE,
				records: makeExcludedChunk('run1', CHUNK_SIZE),
			});
			await sendOperation(ctx.nodeA, { operation: 'upsert', database: DB, table: KEEP_TABLE, records: keepInterleaved });
			await sendOperation(ctx.nodeA, {
				operation: 'upsert',
				database: DB,
				table: EXCLUDED_TABLE,
				records: makeExcludedChunk('run2', CHUNK_SIZE),
			});
			await sendOperation(ctx.nodeA, { operation: 'upsert', database: DB, table: KEEP_TABLE, records: keepAfter });
			console.log(
				`Wrote ${2 * CHUNK_SIZE} excluded rows (2 runs) + ${keepInterleaved.length + keepAfter.length} interleaved ` +
					`keep rows to A in ${Date.now() - writeStart}ms`
			);

			const excludedOnASoFar = await countRows(ctx.nodeA, EXCLUDED_TABLE);
			equal(excludedOnASoFar, 2 * CHUNK_SIZE, 'sender A should locally have both excluded-table bursts before B reconnects');

			// 3. Start the responsiveness probe, THEN restart B so its reconnect (and A's replay
			//    of the two excluded skip runs) happens while we're already sampling.
			const pingSamples = [];
			const stopFlag = { stop: false };
			const pingPromise = pingLoop(ctx.nodeA, pingSamples, stopFlag, 15);

			const ctxForRestartB = { name: ctx.name, harper: { dataRootDir: bDataRootDir, hostname: bHostname } };
			const restartStart = Date.now();
			const resultB = await startHarper(ctxForRestartB, nodeConfig(bHostname, ctx.hostnameA));
			ctx.nodeB = resultB.harper ?? ctxForRestartB.harper;
			console.log('B restarted — reconnecting with its pre-burst resume cursor');

			// 4. Wait for the keep rows behind both skip runs to actually arrive at B (or time out).
			const allKeepIds = [...keepInterleaved, ...keepAfter].map((r) => r.id);
			const missingAfterCatchup = await waitForIds(ctx.nodeB, KEEP_TABLE, allKeepIds, CATCHUP_TIMEOUT_MS);
			const catchupMs = Date.now() - restartStart;

			stopFlag.stop = true;
			await pingPromise;

			const rtts = pingSamples.map((s) => s.rtt);
			const maxRtt = Math.max(...rtts);
			const avgRtt = rtts.reduce((a, b) => a + b, 0) / rtts.length;
			console.log(
				`Catch-up took ${catchupMs}ms; ${rtts.length} pings on A during the window, avg ${avgRtt.toFixed(1)}ms, ` +
					`max ${maxRtt}ms (threshold ${PING_STALL_THRESHOLD_MS}ms)`
			);

			// --- Precondition (hard-assert, non-vacuous): the skip runs were real and really skipped ---
			const excludedOnA = await countRows(ctx.nodeA, EXCLUDED_TABLE);
			const excludedOnB = await countRows(ctx.nodeB, EXCLUDED_TABLE);
			console.log(`Precondition check: excluded-table rows — A=${excludedOnA}, B=${excludedOnB}`);
			equal(excludedOnA, 2 * CHUNK_SIZE, `PRECONDITION FAILED: source A should have ${2 * CHUNK_SIZE} excluded rows`);
			equal(excludedOnB, 0, 'PRECONDITION FAILED: excluded-table rows leaked to B — excludeTables route is not excluding');

			// --- Assertion 1: subscribed-table rows behind both excluded runs arrived at B ---
			equal(
				missingAfterCatchup.length,
				0,
				`DEFECT-SHAPE: keep-table rows behind the excluded skip runs never arrived at B within ` +
					`${CATCHUP_TIMEOUT_MS}ms (missing: ${missingAfterCatchup.join(', ')}) — the replay may be wedged ` +
					`on the not-subscribed-table run`
			);

			// --- Assertion 2: event-loop responsiveness on A during the skip-run replay ---
			ok(
				maxRtt < PING_STALL_THRESHOLD_MS,
				`DEFECT-SHAPE: A's operationsAPI ping latency spiked to ${maxRtt}ms (avg ${avgRtt.toFixed(1)}ms) while ` +
					`replaying two ${CHUNK_SIZE}-row not-subscribed-table (excludeTables) skip runs to B — the send loop ` +
					`is not yielding to the event loop as expected from #536's fix`
			);
		}
	);

	test('keep-table replication still works cleanly after the excluded-table burst (no wedge)', async () => {
		const id = 'post-burst-' + Date.now();
		await sendOperation(ctx.nodeA, { operation: 'upsert', database: DB, table: KEEP_TABLE, records: [{ id, value: 'after-burst' }] });
		const missing = await waitForIds(ctx.nodeB, KEEP_TABLE, [id], 20000);
		equal(missing.length, 0, 'post-burst keep-table write did not replicate — connection may be wedged after the skip-run');
		console.log('Post-burst sanity: keep-table replication still live — no wedge');
	});
});
