/**
 * QA-651 — post-failover write-visibility divergence (HarperFast/harper gh#1846,
 * `bug,area:storage,area:replication`).
 *
 * Bring up a 3-node FULL MESH (A-B, A-C, B-C — not a star: B and C must stay able
 * to talk to each other once A is gone). Drive a steady write stream into A, KILL
 * A mid-stream, then take writes on survivor B. Read those writes back through
 * every surface on every surviving node:
 *   - indexed query   (search_by_value on the indexed `writer` attribute)
 *   - primary point-read (search_by_id)
 *   - full table scan (search_by_value on the primary key wildcard, client-filtered)
 *   - SQL             (operation: 'sql')
 *   - REST            (GET /Ledger/?writer=<tag>, indexed-attribute query)
 *   - RAW INDEX STORE (component endpoint directly scanning
 *     `tables.Ledger.indices.writer.getRange({ start: null })` — the only surface
 *     that can reveal a dangling index entry; see resources.js)
 *   - RAW BASE STORE  (same endpoint, `tables.Ledger.primaryStore.getRange({ start: null })`)
 *
 * The raw-index/raw-base dump is the D-230/D-242-mandated oracle: search_by_value,
 * REST, and SQL all join through the primary record and skip on absence, so none
 * of them can ever prove an index entry is dangling (or that a base row is
 * missing its index entry) — only the direct store scan can.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal, deepEqual } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import {
	startHarper,
	teardownHarper,
	killHarper,
	getNextAvailableLoopbackAddress,
	targz,
} from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, fetchWithRetry, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const PRE_KILL_TARGET = 15; // writes that must be ACKed by A before we trigger the kill
const PRE_KILL_MAX_ATTEMPTS = 2000; // large enough that the stream never finishes "naturally"
const PRE_KILL_WRITE_DELAY_MS = 20; // paces the stream so the poll loop can interrupt it mid-flight
const POST_KILL_COUNT = 25; // writes taken on survivor B after A is dead

// Restart must re-pass the original config (analytics + replication.securePort) —
// startHarper({harper:node}, options) without options.config wipes it, killing
// replication silently. Keep this as the single source of truth for both the
// initial start and any later restart.
function nodeStartOptions(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true },
			replication: { securePort: hostname + ':9933' },
		},
	};
}

async function pollHealth(node, { retries = 60, intervalMs = 1000 } = {}) {
	let last;
	for (let i = 0; i < retries; i++) {
		try {
			const r = await fetch(`${node.operationsAPIURL}/health`);
			if (r.ok) return;
			last = new Error(`status ${r.status}`);
		} catch (err) {
			last = err;
		}
		await delay(intervalMs);
	}
	throw new Error(`Node ${node.hostname} never became healthy: ${last?.message}`);
}

/**
 * Drives a sequential (fully awaited, one-at-a-time) write stream against `node`,
 * tagging every record with `tag` so surfaces can later filter on it. `acked` is
 * mutated live (pushed to as soon as each upsert is confirmed) so a caller can poll
 * it in real time to know exactly how many writes have landed *before* taking some
 * other action (e.g. killing the node) — this is what lets us assert the kill was
 * genuinely mid-stream rather than racing an unobserved burst.
 */
function makeWriteStream(node, tag, { maxCount, delayMs = 0 } = {}) {
	const acked = [];
	let attempted = 0;
	const promise = (async () => {
		for (let i = 0; i < maxCount; i++) {
			attempted = i + 1;
			const id = `${tag}-${i}`;
			try {
				await sendOperation(node, {
					operation: 'upsert',
					database: 'data',
					table: 'Ledger',
					records: [{ id, writer: tag, seq: i, payload: `payload-${tag}-${i}` }],
				});
				acked.push(id);
			} catch (err) {
				return { stoppedOnError: true, error: String(err?.message ?? err), attempted, ackedCount: acked.length };
			}
			if (delayMs) await delay(delayMs);
		}
		return { stoppedOnError: false, attempted, ackedCount: acked.length };
	})();
	return { acked, promise };
}

/** Read every query surface + the raw index/base dump for `tag` on `node`. */
async function surfaceProbe(node, tag, expectedIds) {
	const indexed = await sendOperation(node, {
		operation: 'search_by_value',
		database: 'data',
		table: 'Ledger',
		search_attribute: 'writer',
		search_value: tag,
		get_attributes: ['id'],
	}).catch(() => []);

	const pointRead = await sendOperation(node, {
		operation: 'search_by_id',
		database: 'data',
		table: 'Ledger',
		ids: expectedIds,
		get_attributes: ['id'],
	}).catch(() => []);

	// Full table scan: wildcard on the PRIMARY key, so this walks primaryStore
	// directly and never touches the `writer` secondary index. Client-side
	// filter down to this tag.
	const fullScanAll = await sendOperation(node, {
		operation: 'search_by_value',
		database: 'data',
		table: 'Ledger',
		search_attribute: 'id',
		search_value: '*',
		get_attributes: ['id', 'writer'],
	}).catch(() => []);
	const fullScan = fullScanAll.filter((r) => r.writer === tag);

	const sqlRows = await sendOperation(node, {
		operation: 'sql',
		sql: `SELECT id FROM data.Ledger WHERE writer = '${tag}'`,
	}).catch(() => []);

	let rest = [];
	try {
		const restResp = await fetchWithRetry(`${node.httpURL}/Ledger/?writer=${tag}`, { retries: 5 });
		if (restResp.ok) rest = await restResp.json();
	} catch {
		// leave rest === []
	}

	let dump = { indexEntries: [], baseEntries: [] };
	try {
		const dumpResp = await fetchWithRetry(`${node.httpURL}/IndexDump?tag=${tag}`, { retries: 5 });
		if (dumpResp.ok) dump = await dumpResp.json();
	} catch {
		// leave dump empty
	}

	const baseIds = new Set(dump.baseEntries.map((e) => e.id));
	const indexIds = new Set(dump.indexEntries.map((e) => e.id));
	const danglingIndexIds = [...indexIds].filter((id) => !baseIds.has(id)); // index entry, no base row
	const danglingBaseIds = [...baseIds].filter((id) => !indexIds.has(id)); // base row, no index entry

	return {
		indexedCount: indexed.length,
		pointReadCount: pointRead.length,
		fullScanCount: fullScan.length,
		sqlCount: sqlRows.length,
		restCount: Array.isArray(rest) ? rest.length : 0,
		rawIndexCount: indexIds.size,
		rawBaseCount: baseIds.size,
		danglingIndexIds,
		danglingBaseIds,
	};
}

function logProbe(label, probe) {
	console.log(
		`[QA-651] ${label}: indexed=${probe.indexedCount} pointRead=${probe.pointReadCount} ` +
			`fullScan=${probe.fullScanCount} sql=${probe.sqlCount} rest=${probe.restCount} ` +
			`rawIndex=${probe.rawIndexCount} rawBase=${probe.rawBaseCount} ` +
			`danglingIndex=${JSON.stringify(probe.danglingIndexIds)} danglingBase=${JSON.stringify(probe.danglingBaseIds)}`
	);
}

suite('QA-651: post-failover write-visibility divergence', { timeout: 480000 }, (ctx) => {
	before(async () => {
		const hostnames = await Promise.all([
			getNextAvailableLoopbackAddress(),
			getNextAvailableLoopbackAddress(),
			getNextAvailableLoopbackAddress(),
		]);

		ctx.nodes = await Promise.all(
			hostnames.map(async (hostname) => {
				const nodeCtx = { name: ctx.name, harper: { hostname } };
				await startHarper(nodeCtx, nodeStartOptions(hostname));
				return nodeCtx.harper;
			})
		);
		[ctx.nodeA, ctx.nodeB, ctx.nodeC] = ctx.nodes;

		// Full mesh: A-B, A-C, B-C. Star topology would leave B and C unable to
		// talk to each other once A (the hub) dies — the opposite of what this
		// scenario needs.
		const meshPairs = [
			[ctx.nodeB, ctx.nodeA],
			[ctx.nodeC, ctx.nodeA],
			[ctx.nodeC, ctx.nodeB],
		];
		for (const [follower, leader] of meshPairs) {
			await sendOperation(follower, {
				operation: 'add_node',
				hostname: leader.hostname,
				rejectUnauthorized: false,
				authorization: follower.admin,
			});
		}

		// Wait for the full mesh (each node sees 2 peers, all sockets connected).
		let retries = 0;
		while (true) {
			const statuses = await Promise.all(ctx.nodes.map((n) => sendOperation(n, { operation: 'cluster_status' })));
			const meshed = statuses.every(
				(s) =>
					s.connections.length === 2 && s.connections.every((c) => c.database_sockets.every((sock) => sock.connected))
			);
			if (meshed) break;
			if (retries++ > 30) throw new Error('Mesh never fully connected: ' + JSON.stringify(statuses));
			await delay(300 * retries);
		}

		// Deploy the Ledger table + IndexDump diagnostic component from A; replicated
		// so schema + resource code lands on B and C too.
		const payload = await targz(join(import.meta.dirname, 'fixture-failover-write-visibility'));
		const deployResp = await sendOperation(ctx.nodeA, {
			operation: 'deploy_component',
			project: 'qa651-app',
			payload,
			replicated: true,
			restart: true,
		});
		console.log('[QA-651] deploy_component response:', JSON.stringify(deployResp));
		await delay(15000);
		for (const node of ctx.nodes) await pollHealth(node);
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n }).catch(() => null)));
	});

	test('kill the leader mid-stream, take writes on a survivor, probe every surface', async () => {
		const { nodeA, nodeB, nodeC } = ctx;

		// --- Phase 1: steady write stream into A, kill A genuinely mid-stream ---
		const preKill = makeWriteStream(nodeA, 'pre', {
			maxCount: PRE_KILL_MAX_ATTEMPTS,
			delayMs: PRE_KILL_WRITE_DELAY_MS,
		});
		while (preKill.acked.length < PRE_KILL_TARGET) await delay(50);
		const ackedAtKillTrigger = preKill.acked.length;
		console.log(`[QA-651] triggering kill of A after ${ackedAtKillTrigger} acked writes`);
		await killHarper({ harper: nodeA });
		const preKillResult = await preKill.promise;
		console.log('[QA-651] preKill stream result:', JSON.stringify(preKillResult));

		// PRECONDITION: the kill must have actually interrupted a live stream, not
		// raced an already-finished one. Assert both that we had enough acked
		// writes before triggering the kill, AND that the writer subsequently hit
		// a real failure talking to the now-dead A (proof it was still trying).
		ok(
			ackedAtKillTrigger >= PRE_KILL_TARGET,
			`precondition failed: only ${ackedAtKillTrigger} writes acked before kill trigger, wanted >= ${PRE_KILL_TARGET}`
		);
		ok(
			preKillResult.stoppedOnError,
			'precondition failed: write stream to A ran to completion without ever failing — kill was not mid-stream armed'
		);
		ok(
			preKillResult.attempted < PRE_KILL_MAX_ATTEMPTS,
			'precondition failed: stream reached maxCount, meaning it was never actually interrupted'
		);
		console.log(
			`[QA-651] PRECONDITION ARMED: A killed mid-stream after ${preKillResult.ackedCount} acked / ` +
				`${preKillResult.attempted} attempted writes (error: ${preKillResult.error})`
		);

		// --- Phase 2: take writes on survivor B ---
		const postKill = makeWriteStream(nodeB, 'post', { maxCount: POST_KILL_COUNT, delayMs: 0 });
		const postKillResult = await postKill.promise;
		console.log('[QA-651] postKill stream result:', JSON.stringify(postKillResult));
		equal(postKillResult.stoppedOnError, false, 'writes to survivor B should not fail');
		equal(postKillResult.ackedCount, POST_KILL_COUNT, 'all post-kill writes should be ACKed by B');
		const postIds = postKill.acked.slice();
		const preIds = preKill.acked.slice();

		// --- Phase 3: immediate (pre-convergence) snapshot — informational only ---
		const immediateB = await surfaceProbe(nodeB, 'post', postIds);
		const immediateC = await surfaceProbe(nodeC, 'post', postIds);
		logProbe('immediate B (post-kill batch, before catch-up wait)', immediateB);
		logProbe('immediate C (post-kill batch, before catch-up wait)', immediateC);

		// --- Phase 4: wait for B/C convergence on the post-kill batch ---
		// Tag-scoped rather than a table-wide count: the pre-kill batch is still landing here, so
		// only the post-kill writer tag distinguishes "the batch arrived".
		let bCount = 0;
		let cCount = 0;
		const countTagged = (node, signal) =>
			sendOperation(
				node,
				{
					operation: 'search_by_value',
					database: 'data',
					table: 'Ledger',
					search_attribute: 'writer',
					search_value: 'post',
				},
				{ signal }
			).then((r) => r.length);
		await waitForCondition(
			async (signal) => {
				[bCount, cCount] = await Promise.all([countTagged(nodeB, signal), countTagged(nodeC, signal)]);
				return bCount === POST_KILL_COUNT && cCount === POST_KILL_COUNT;
			},
			{
				timeoutMs: 20_000,
				description: () =>
					`the post-kill batch (${POST_KILL_COUNT} writes) to converge across B (${bCount}) and C (${cCount})`,
			}
		);
		console.log(`[QA-651] post-kill batch converged across B/C: B ${bCount}, C ${cCount}`);

		// --- Phase 5: full 5-surface + raw-store probe on both survivors, both tags ---
		const results = {};
		for (const [label, node] of [
			['B', nodeB],
			['C', nodeC],
		]) {
			results[label] = {
				pre: await surfaceProbe(node, 'pre', preIds),
				post: await surfaceProbe(node, 'post', postIds),
			};
			logProbe(`${label} / pre (kill-window batch, informational)`, results[label].pre);
			logProbe(`${label} / post (fully-controlled survivor batch)`, results[label].post);
		}

		// --- THE CORE QUESTION: index-vs-base, not merely node-vs-node ---
		// For the fully-controlled post-kill batch, on EVERY surviving node, the raw
		// index store and the raw base store must agree exactly — no dangling index
		// entries (index committed without base row) and no orphaned base rows
		// (base committed without its index entry).
		for (const label of ['B', 'C']) {
			const post = results[label].post;
			deepEqual(post.danglingIndexIds, [], `${label}: dangling index entries (index-ahead-of-base) for post batch`);
			deepEqual(post.danglingBaseIds, [], `${label}: orphaned base rows (base-ahead-of-index) for post batch`);
		}

		// Node-vs-node: after convergence, B and C must agree with each other and
		// with the ground truth count across EVERY surface for the post batch.
		for (const surfaceKey of [
			'indexedCount',
			'pointReadCount',
			'fullScanCount',
			'sqlCount',
			'restCount',
			'rawIndexCount',
			'rawBaseCount',
		]) {
			equal(
				results.B.post[surfaceKey],
				POST_KILL_COUNT,
				`B: ${surfaceKey} for post batch expected ${POST_KILL_COUNT}, got ${results.B.post[surfaceKey]}`
			);
			equal(
				results.C.post[surfaceKey],
				POST_KILL_COUNT,
				`C: ${surfaceKey} for post batch expected ${POST_KILL_COUNT}, got ${results.C.post[surfaceKey]}`
			);
		}

		// For the 'pre' (kill-window) batch we do NOT assert full counts — some of
		// those acked-by-A writes may legitimately never have reached B/C before A
		// died (an expected async-replication loss window, not a bug). But whatever
		// DID land must still be internally consistent: no dangling index entries,
		// no orphaned base rows, regardless of how far replication got.
		for (const label of ['B', 'C']) {
			const pre = results[label].pre;
			deepEqual(pre.danglingIndexIds, [], `${label}: dangling index entries for pre (kill-window) batch`);
			deepEqual(pre.danglingBaseIds, [], `${label}: orphaned base rows for pre (kill-window) batch`);
		}

		// --- Phase 6: restart survivor C and re-probe — does anything change across a restart? ---
		console.log('[QA-651] restarting C to probe self-heal-vs-restart-regression');
		await killHarper({ harper: nodeC });
		ctx.nodeC = (await startHarper({ harper: nodeC }, nodeStartOptions(nodeC.hostname))).harper;
		// after()'s teardown loop walks ctx.nodes — keep the restarted process's handle
		// in sync there too, or teardown targets the pre-restart (now-dead) process and
		// leaks the new one.
		ctx.nodes[2] = ctx.nodeC;
		await pollHealth(ctx.nodeC, { retries: 60, intervalMs: 1000 });
		await delay(2000); // let the restarted node's cleanup/backfill (if any) settle

		const postRestartC = await surfaceProbe(ctx.nodeC, 'post', postIds);
		logProbe('C / post, AFTER restart', postRestartC);
		deepEqual(postRestartC.danglingIndexIds, [], 'C after restart: dangling index entries appeared post-restart');
		deepEqual(postRestartC.danglingBaseIds, [], 'C after restart: orphaned base rows appeared post-restart');
		for (const surfaceKey of [
			'indexedCount',
			'pointReadCount',
			'fullScanCount',
			'sqlCount',
			'restCount',
			'rawIndexCount',
			'rawBaseCount',
		]) {
			equal(
				postRestartC[surfaceKey],
				POST_KILL_COUNT,
				`C after restart: ${surfaceKey} expected ${POST_KILL_COUNT}, got ${postRestartC[surfaceKey]} ` +
					`(pre-restart was ${results.C.post[surfaceKey]}) — restart introduced divergence`
			);
		}
	});
});
