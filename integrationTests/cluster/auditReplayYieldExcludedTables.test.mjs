/**
 * QA-690: regression anchor for harper-pro#535 ("Audit replay loop starves the event
 * loop on long not-subscribed-table runs"), fixed by 70ec9485
 * (fix(replication): yield the audit replay loop on not-subscribed table skips (#536)).
 *
 * Mechanism (restored from qa522-audit-replay-yield-live.test.mjs after review on PR
 * #612: kriszyp traced replicationConnection.ts and confirmed the excludeTables variant
 * this spec originally shipped with never reaches the `!tableEntry` branch #536 fixed --
 * `sendExcludedTables?.has(table.tableName)` already called the yielding
 * `skipAuditRecord()` both before and after the fix, so it would stay green even with
 * #536 reverted). The only way to force `tableToTableEntry(...)` to actually resolve
 * `undefined` is the "dropped table" trick from the fix's own comment: create a table,
 * write to it, drop it, then restart the sender so its fresh table registry (rebuilt at
 * boot from the *current* set of local tables) never learns the dropped table existed.
 *
 * Scale: 70k rows in the single dropped table, vs qa522's 50k -- the only axis this spec
 * adds over qa522.
 *
 * On "traffic behind the skip run" and multi-run interleaving (both tried, both reverted
 * -- important non-obvious finding, verified empirically by reverting #536 and
 * re-running): the load-bearing oracle here is B's `lastReceivedVersion` advancing
 * progressively during the run (see below). That signal ONLY means anything if nothing
 * real is ever forwarded during the whole probe window except the (skipped) ghost
 * entries. Any real record delivered anywhere downstream of the resume point --
 * interleaved mid-run, or simply sitting after the drop as "traffic behind the burst"
 * (even placed after A's restart, still before B reconnects) -- advances
 * `lastReceivedVersion` on its own via the normal forwarding path, completely independent
 * of whether the not-subscribed skip path yields. That makes the oracle pass regardless
 * of #536's presence, i.e. vacuous. Confirmed directly: a variant with a `keep`-table
 * write placed after the ghost drop passed even with #536 reverted; removing it restored
 * the correct fail. So this spec, like qa522, asserts only on the skip-run's own
 * behavior -- no data sits behind it in the same reconnect window. The pre/post sanity
 * tests (below) independently prove the connection still carries real subscribed
 * traffic before and after, without ever placing that traffic behind the burst itself.
 *
 * Shape:
 *   - A and B join via plain add_node (whole database 'data'). B is taken offline.
 *   - While offline, A creates 'ghost', writes a single 70k-row burst to it, then drops
 *     it, with nothing else written afterward. A is itself killed and restarted (same
 *     dataRootDir) so its fresh table registry has no entry for the now-gone tableId --
 *     the whole 70k-entry run hits the `!tableEntry` skip path in one uninterrupted walk
 *     once B reconnects.
 *   - A is left at `threads.count: 1` so an external operationsAPI ping necessarily
 *     shares its single event loop with the replication send loop doing the replay.
 *   - B is restarted (same dataRootDir) and reconnects using its pre-burst persisted
 *     resume cursor. While A replays the backlog, we poll (1) A's operationsAPI on a
 *     short interval and (2) B's `cluster_status` for its resume-cursor's
 *     `lastReceivedVersion` against A, matching qa522's dual-probe design.
 *
 * On the ping-latency signal (verified empirically, not assumed): at this record
 * count/payload, max ping latency barely moves between fixed and reverted #536 (this
 * environment: single-digit ms either way, far under the threshold below) -- the
 * production stalls (11+ minutes) presumably involved far more/heavier entries than a
 * local 70k-row synthetic run reproduces as wall-clock event-loop starvation. The
 * threshold is kept as a defense-in-depth signal (matches qa522's own design), NOT the
 * load-bearing oracle.
 *
 * The load-bearing oracle is qa522's cursor-progress sample: `skipAuditRecord()` (the
 * fixed path) sends a sequence-position update via its trailing `return new
 * Promise(setImmediate)` yield while the reverted path (`logger.debug?.(...)`) sends
 * none until the whole synchronous walk finally completes. Confirmed against this exact
 * mechanism in this environment: reverting #536 and re-running (3 cold reruns)
 * consistently reproduces qa522's negative-control failure (`DEFECT-SHAPE: B's
 * lastReceivedVersion only showed 1 distinct value(s)`); re-applying the fix consistently
 * passes (3 cold reruns, >=2 distinct, monotonic).
 *
 * Preconditions (hard-asserted, non-vacuous):
 *   - the burst actually landed on A before the drop (the skip run was really that
 *     large), and
 *   - after A's restart, `describe_table` for 'ghost' fails on A (the registry entry is
 *     genuinely gone -- this is what forces `!tableEntry`, not just an unsent table).
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
import {
	startHarper,
	killHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const DB = 'data';
const GHOST_TABLE = 'ghost';
const KEEP_TABLE = 'keep';
const GHOST_COUNT = 70000; // larger than qa522's single 50k run
// Generous: production stalls were 11+ minutes. A local single-pass skip-run should stay
// near-baseline (sub-second) if the fix is doing its job; anything crossing this means
// the loop is not yielding like it should. Not the load-bearing oracle -- see file header.
const PING_STALL_THRESHOLD_MS = 4000;
// Fixed window for the ping/cursor probes, matching qa522's design. The whole run
// completes in a couple of seconds on a local machine regardless of fix state at this
// scale, so the window just needs to comfortably span that to catch qa522's proven
// pass/fail signal (see header).
const PROBE_WINDOW_MS = 8000;
const CURSOR_SAMPLE_INTERVAL_MS = 150;

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

/**
 * Poll cluster_status on `node` for the connection to `peerHostname`, collecting timestamped
 * lastReceivedVersion samples until `stopFlag.stop` is set. Proves the resume cursor advances
 * progressively during a skip-run rather than only jumping once at the end.
 */
async function sampleCursorProgress(node, peerHostname, samples, stopFlag, intervalMs = 150) {
	while (!stopFlag.stop) {
		const status = await sendOperation(node, { operation: 'cluster_status' }).catch(() => null);
		const conn = (status?.connections ?? []).find((c) => (c.url ?? c.name ?? '').includes(peerHostname));
		const versions = (conn?.database_sockets ?? [])
			.map((s) => s.lastReceivedVersion)
			.filter((v) => typeof v === 'number');
		if (versions.length) samples.push({ t: Date.now(), version: Math.max(...versions) });
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

function nodeConfig(hostname, { singleThread = false } = {}) {
	const config = {
		analytics: { aggregatePeriod: -1 },
		// Deliberately NOT 'debug' — the bug's precondition is `logger.debug?.()`
		// evaluating to `undefined` at production log level.
		logging: { level: 'warn', colors: false, stdStreams: true, console: true },
		replication: { port: hostname + ':9933', securePort: null, databases: [DB] },
	};
	if (singleThread) config.threads = { count: 1 };
	// Deliberately NOT HARPER_NO_FLUSH_ON_EXIT: we want clean, fully-flushed restarts so the
	// local crash-recovery WAL replay (a separate mechanism, harper-pro#1266) never fires and
	// competes with/masks the thing under test — the replication SEND loop's own skip-run walk.
	return { config };
}

suite(
	'QA-690: audit replay loop yields on dropped-table skip run (harper-pro#535/#536)',
	{ timeout: 300000 },
	(ctx) => {
		before(async () => {
			const hostnameA = await getNextAvailableLoopbackAddress();
			const hostnameB = await getNextAvailableLoopbackAddress();

			const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
			const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };

			await Promise.all([
				startHarper(ctxA, nodeConfig(hostnameA, { singleThread: true })).then(() => {
					ctx.nodeA = ctxA.harper;
				}),
				startHarper(ctxB, nodeConfig(hostnameB)).then(() => {
					ctx.nodeB = ctxB.harper;
				}),
			]);

			// 'keep' exists on both -- this is the sanity table we use to prove the connection
			// is alive before and after the ghost skip run.
			for (const node of [ctx.nodeA, ctx.nodeB]) {
				await sendOperation(node, { operation: 'create_table', database: DB, table: KEEP_TABLE, primary_key: 'id' });
			}

			// Plain whole-database join: B subscribes to A for all of 'data'.
			await sendOperation(ctx.nodeB, {
				operation: 'add_node',
				hostname: ctx.nodeA.hostname,
				rejectUnauthorized: false,
				authorization: ctx.nodeA.admin,
			});

			const connected = await waitForConnected(ctx.nodeB);
			ok(connected, 'B did not form a connected cluster to A');
			console.log('Cluster up — A:', ctx.nodeA.hostname, '(threads:1) B:', ctx.nodeB.hostname);
		});

		after(async () => {
			await Promise.all([
				ctx.nodeA && teardownHarper({ harper: ctx.nodeA }).catch(() => {}),
				ctx.nodeB && teardownHarper({ harper: ctx.nodeB }).catch(() => {}),
			]);
		});

		test('sanity: keep-table replication is live before the ghost burst', async () => {
			const id = 'sanity-' + Date.now();
			await sendOperation(ctx.nodeA, {
				operation: 'upsert',
				database: DB,
				table: KEEP_TABLE,
				records: [{ id, value: 'v1' }],
			});
			const missing = await waitForIds(ctx.nodeB, KEEP_TABLE, [id], 20000);
			equal(missing.length, 0, 'keep-table record did not replicate A->B — cluster is not actually live');
			console.log('Sanity: keep-table replication confirmed live (A->B)');
		});

		test('A stays responsive and B advances progressively while reconnecting through a long dropped-table skip run', async () => {
			// 1. Take B offline. Its persisted resume cursor is captured BEFORE 'ghost' ever
			//    existed, so on reconnect A's sender must walk forward through the whole skip
			//    run to catch it up.
			const bHostname = ctx.nodeB.hostname;
			const bDataRootDir = ctx.nodeB.dataRootDir;
			await killHarper({ harper: ctx.nodeB });
			console.log('B killed (offline) — its resume cursor predates the burst below');

			// 2. While B is offline: one 70k-row burst to 'ghost', written and dropped with
			//    NOTHING else written anywhere in this window -- see the file header for why
			//    "traffic behind the run" would make the cursor-progress oracle below vacuous.
			const ghostRecords = Array.from({ length: GHOST_COUNT }, (_, i) => ({
				id: `ghost-${i}`,
				payload: 'x'.repeat(32),
			}));

			await sendOperation(ctx.nodeA, {
				operation: 'create_table',
				database: DB,
				table: GHOST_TABLE,
				primary_key: 'id',
			});

			const writeStart = Date.now();
			await sendOperation(ctx.nodeA, {
				operation: 'upsert',
				database: DB,
				table: GHOST_TABLE,
				records: ghostRecords,
			});
			console.log(`Wrote ${GHOST_COUNT} ghost rows to A in ${Date.now() - writeStart}ms`);

			// --- Precondition 1 (hard-assert, non-vacuous): the burst really landed on A ---
			const ghostDescBeforeDrop = await sendOperation(ctx.nodeA, {
				operation: 'describe_table',
				database: DB,
				table: GHOST_TABLE,
			});
			equal(
				ghostDescBeforeDrop.record_count,
				GHOST_COUNT,
				`PRECONDITION FAILED: A should have ${GHOST_COUNT} ghost rows before the drop`
			);

			// 3. Drop 'ghost' -- audit entries remain, but the table registry entry is gone.
			await sendOperation(ctx.nodeA, { operation: 'drop_table', database: DB, table: GHOST_TABLE });
			console.log('Dropped ghost table on A — audit entries remain, but the table registry entry is gone');

			// 4. Restart A itself so its per-database table registry
			//    (tableSubscriptionToReplicator.tableById) is rebuilt from scratch by iterating
			//    only the CURRENT set of local tables (replicator.ts:373-377) — it never learns
			//    about the now-dropped ghost tableId at all.
			const aHostname = ctx.nodeA.hostname;
			const aDataRootDir = ctx.nodeA.dataRootDir;
			await killHarper({ harper: ctx.nodeA });
			const ctxForRestartA = { name: ctx.name, harper: { dataRootDir: aDataRootDir, hostname: aHostname } };
			const resultA = await startHarper(ctxForRestartA, nodeConfig(aHostname, { singleThread: true }));
			ctx.nodeA = resultA.harper ?? ctxForRestartA.harper;
			console.log('A restarted — fresh table registry has no entry for the dropped ghost table');

			// --- Precondition 2 (hard-assert, non-vacuous): the drop was durable across restart,
			//     i.e. this is genuinely what forces `!tableEntry`, not just an unsent table ---
			// describe_table on a nonexistent table throws HTTP 404 (schemaDescribe.ts's
			// TABLE_NOT_FOUND), which sendOperation's status-200 assertion turns into an Error --
			// resolving to anything else here would mean the registry entry survived the restart.
			const ghostDescAfterRestart = await sendOperation(ctx.nodeA, {
				operation: 'describe_table',
				database: DB,
				table: GHOST_TABLE,
			}).catch((err) => err);
			ok(
				ghostDescAfterRestart instanceof Error,
				'PRECONDITION FAILED: restarted A can still describe the dropped ghost table — registry entry was not actually gone'
			);

			// 5. Start the concurrent probes, THEN restart B so its reconnect (and A's replay of
			//    the ghost skip-run) happens while we're already sampling.
			const pingSamples = [];
			const cursorSamples = [];
			const stopFlag = { stop: false };
			const pingPromise = pingLoop(ctx.nodeA, pingSamples, stopFlag, 15);
			// B may still be mid-restart when this fires — sampleCursorProgress swallows fetch
			// errors and just skips those ticks, so it's safe to point it at B's (fixed,
			// hostname-derived) operationsAPI URL before the restart promise resolves.
			const cursorPromise = sampleCursorProgress(
				{ operationsAPIURL: `http://${bHostname}:9925` },
				aHostname,
				cursorSamples,
				stopFlag,
				CURSOR_SAMPLE_INTERVAL_MS
			);

			const ctxForRestartB = { name: ctx.name, harper: { dataRootDir: bDataRootDir, hostname: bHostname } };
			const resultB = await startHarper(ctxForRestartB, nodeConfig(bHostname));
			ctx.nodeB = resultB.harper ?? ctxForRestartB.harper;
			console.log('B restarted — reconnecting with its pre-ghost resume cursor');

			await delay(PROBE_WINDOW_MS);
			stopFlag.stop = true;
			await Promise.all([pingPromise, cursorPromise]);

			const rtts = pingSamples.map((s) => s.rtt);
			const maxRtt = Math.max(...rtts);
			const avgRtt = rtts.reduce((a, b) => a + b, 0) / rtts.length;
			console.log(
				`During B's reconnect: ${rtts.length} pings on A, avg ${avgRtt.toFixed(1)}ms, max ${maxRtt}ms ` +
					`(threshold ${PING_STALL_THRESHOLD_MS}ms)`
			);
			console.log(
				'Cursor progress samples on B (t, lastReceivedVersion):',
				cursorSamples.map((s) => `${s.t}:${s.version}`).join(' ')
			);

			// --- Assertion 1 (load-bearing): B's resume cursor advances during the run, not just
			//     once at the end. This is the signal that actually distinguishes fixed vs
			//     pre-#536 code -- see the file header for confirmed pass/fail evidence. ---
			const distinctVersions = new Set(cursorSamples.map((s) => s.version));
			ok(
				distinctVersions.size >= 2,
				`DEFECT-SHAPE: B's lastReceivedVersion only showed ${distinctVersions.size} distinct value(s) ` +
					`across ${cursorSamples.length} samples during the skip-run — periodic sequence updates from ` +
					`skipAuditRecord() are not firing during the run, so a reconnect mid-run would rescan from the start`
			);
			const versionsInOrder = cursorSamples.map((s) => s.version);
			let monotonic = true;
			for (let i = 1; i < versionsInOrder.length; i++) {
				if (versionsInOrder[i] < versionsInOrder[i - 1]) monotonic = false;
			}
			ok(monotonic, "B's lastReceivedVersion regressed during sampling — should be monotonically non-decreasing");

			// --- Assertion 2 (auxiliary, not discriminating at this scale -- see file header):
			//     event-loop responsiveness on A during the skip-run replay ---
			ok(
				maxRtt < PING_STALL_THRESHOLD_MS,
				`DEFECT-SHAPE: A's operationsAPI ping latency spiked to ${maxRtt}ms (avg ${avgRtt.toFixed(1)}ms) ` +
					`while walking ${GHOST_COUNT} not-subscribed-table (dropped) audit entries — the send loop ` +
					`is not yielding to the event loop as expected from #536's fix`
			);
		});

		test('keep-table replication still works cleanly after the ghost skip-run (no wedge)', async () => {
			const id = 'post-burst-' + Date.now();
			await sendOperation(ctx.nodeA, {
				operation: 'upsert',
				database: DB,
				table: KEEP_TABLE,
				records: [{ id, value: 'after-burst' }],
			});
			const missing = await waitForIds(ctx.nodeB, KEEP_TABLE, [id], 20000);
			equal(
				missing.length,
				0,
				'post-burst keep-table write did not replicate — connection may be wedged after the skip-run'
			);
			console.log('Post-burst sanity: keep-table replication still live — no wedge');
		});
	}
);
