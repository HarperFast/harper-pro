/**
 * Regression guard for the permanent blob-replication WEDGE on a confidently-INCOMPLETE source blob
 * (harper-pro#429). Sibling to replicationBlobSourceUnavailable.test.mjs, which covers the MISSING
 * (ENOENT/404) source blob; this one covers the TRUNCATED ("Blob is incomplete", 500) source blob.
 *
 * Mechanism (replication/replicationConnection.ts + core resources/blob.ts, harper#1425):
 *   - The SOURCE has a blob whose on-disk body is short of its header's declared size (the truncate
 *     fixture cuts it post-write). When `sendBlobs` -> `blob.stream()` reads it, core finds the body
 *     incomplete after the writer has finished and rejects with `BlobReadError('Blob is incomplete',
 *     500)` — carrying a statusCode, NOT a raw fs `.code`.
 *   - `sendBlobs` forwards a BLOB_CHUNK `error` marker with `errorStatus: 500`. The receiver
 *     `stream.destroy()`s the blob stream and `saveBlob` rejects.
 *   - BEFORE this fix, `isPermanentSourceBlobErrorCode` keyed only on `errorCode === 'ENOENT'`, so a
 *     500 (no code) was misclassified TRANSIENT: `receiveBlobs` set `hasBlobGap`, pinning the resume
 *     cursor; every reconnect re-streams the same truncated blob and re-fails — wedged forever (#429).
 *   - The fix classifies 500 (and 404) as a PERMANENT source failure and advances the cursor PAST it
 *     (recorded loudly via `markSourceBlobUnavailable`), leaving the record for backfill (#388), while
 *     still HOLDING for genuinely local/transient save faults (the createWriteStream injectors).
 *
 * The discriminating signal is B's log: FIXED code emits "advancing the resume cursor past it" for an
 * INCOMPLETE source blob; UNFIXED code emits only "Blob save failed for ..." and never advances. We
 * additionally assert the failure was the incomplete/500 path (not ENOENT) to prove THIS classifier
 * arm. Heavy/stress-gated like its siblings.
 *
 * NB requires a `core` submodule that includes harper#1425 (the BlobReadError statusCode taxonomy).
 * Until that lands on harper-pro's pinned core, this only runs under HARPER_RUN_STRESS_TESTS=1.
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { connect as netConnect } from 'node:net';

// Wait until a TCP connect to host:port succeeds — i.e. the replication server has actually bound its
// secure port. The CSR exchange in add_node connects directly to that port and throws on ECONNREFUSED
// with no internal retry, so on a host where the replication listener takes a few seconds to bind we
// must not fire add_node before it is accepting (otherwise setup races and fails).
async function waitForPort(host, port, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const open = await new Promise((resolve) => {
			const socket = netConnect({ host, port }, () => {
				socket.destroy();
				resolve(true);
			});
			socket.on('error', () => resolve(false));
			socket.setTimeout(1000, () => {
				socket.destroy();
				resolve(false);
			});
		});
		if (open) return true;
		await delay(250);
	}
	return false;
}
import {
	startHarper,
	teardownHarper,
	setupHarperWithFixture,
	getNextAvailableLoopbackAddress,
	targz,
} from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, fetchWithRetry, concurrent, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const RECORDS = Number.parseInt(process.env.HARPER_TEST_INCOMPLETE_RECORDS || '120', 10);
const REQ_CONCURRENCY = Number.parseInt(process.env.HARPER_TEST_INCOMPLETE_CONCURRENCY || '20', 10);
// Truncate a deterministic subset of blobs on the SOURCE (fileId % MODULUS === 0) so those blobs are
// PERMANENTLY incomplete (the header outlives the body, every read re-fails), while the rest replicate.
const TRUNCATE_MODULUS = process.env.HARPER_TEST_BLOB_TRUNCATE_MODULUS || '5';
const BLOB_CHUNKS = process.env.HARPER_TEST_BLOB_CHUNKS || '16'; // 16 * 4096 = 64 KB per blob (file-backed)
const CONVERGE_TIMEOUT_MS = Number.parseInt(process.env.HARPER_TEST_INCOMPLETE_CONVERGE_MS || '60000', 10);

const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';

suite('Incomplete (truncated) source blob does not permanently wedge replication', { skip: !STRESS, timeout: 300000 }, (ctx) => {
	before(async () => {
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const sharedConfig = (host) => ({
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, console: true, level: 'debug' },
			replication: { securePort: host + ':9933' },
		});
		// A is the SENDER: install the source truncate injector so a subset of its blobs are incomplete.
		await setupHarperWithFixture(nodeA, join(import.meta.dirname, 'fixture-blob-truncate-source'), {
			config: sharedConfig(nodeA.harper.hostname),
			env: {
				HARPER_NO_FLUSH_ON_EXIT: true,
				HARPER_TEST_BLOB_CHUNKS: BLOB_CHUNKS,
				HARPER_TEST_BLOB_TRUNCATE_MODULUS: TRUNCATE_MODULUS,
			},
		});
		await startHarper(nodeB, {
			config: sharedConfig(nodeB.harper.hostname),
			env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_BLOB_CHUNKS: BLOB_CHUNKS },
		});
		ctx.nodes = [nodeA.harper, nodeB.harper];

		// A's replication server (the secure port add_node connects to for the CSR exchange) can take a
		// few seconds to bind after startup; wait for it so setup doesn't race into ECONNREFUSED.
		ok(
			await waitForPort(nodeA.harper.hostname, 9933),
			`node A replication server never started listening on ${nodeA.harper.hostname}:9933`
		);

		// Connect A↔B.
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
		for (let retries = 0; retries < 15; retries++) {
			const status = await Promise.all(ctx.nodes.map((n) => sendOperation(n, { operation: 'cluster_status' })));
			if (status.every((r) => (r.connections ?? []).every((c) => (c.database_sockets ?? []).every((s) => s.connected))))
				break;
			await delay(200 * (retries + 1));
		}

		// Deploy the caching blob component to A; `replicated: true` installs it on B too.
		const payload = await targz(join(import.meta.dirname, 'fixture-blob-gap-deadlock-source'));
		await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project: 'blob-gap-deadlock-source',
			payload,
			replicated: true,
			restart: true,
		});
		await delay(35000);

		const bootLog = await readLog(ctx.nodes[0]);
		ok(
			bootLog.includes('[blob-truncate-source] installed'),
			'source truncate injector did not load on A — test would not exercise the incomplete-source path'
		);

		// Wait for replication to be LIVE before driving load (same race guard as its siblings).
		const probeId = 9_000_000 + Math.floor(Math.random() * 1000);
		await fetchWithRetry(ctx.nodes[0].httpURL + '/Prerender/' + probeId);
		let live = false;
		for (let i = 0; i < 90; i++) {
			const bDesc = await sendOperation(ctx.nodes[1], { operation: 'describe_table', table: 'Prerender' });
			if ((bDesc.record_count ?? 0) > 0) {
				live = true;
				break;
			}
			await delay(1000);
		}
		ok(live, 'replication from A to B never went live within 90s — setup race, not a wedge');
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n })));
	});

	test('receiver advances past an incomplete (500) source blob instead of wedging the cursor', async () => {
		const [A, B] = ctx.nodes;

		// Drive RECORDS distinct cache misses on A (each mints a new file-backed blob), continuously,
		// so the source's replication send reads a subset of blobs back as truncated/incomplete.
		let nextId = 0;
		const { execute, finish } = concurrent(() => fetchWithRetry(A.httpURL + '/Prerender/' + nextId++), REQ_CONCURRENCY);
		const loadPromise = (async () => {
			for (let i = 0; i < RECORDS; i++) await execute();
			await finish();
		})();

		// B should keep converging — the apply loop never blocks on blobs — and, critically, take the
		// advance branch for the incomplete source blobs rather than holding the cursor forever.
		const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
		let bCount = 0;
		let aCount = 0;
		let loadDone = false;
		loadPromise.then(() => (loadDone = true)).catch(() => (loadDone = true));
		while (Date.now() < deadline) {
			aCount = (await sendOperation(A, { operation: 'describe_table', table: 'Prerender' })).record_count;
			bCount = (await sendOperation(B, { operation: 'describe_table', table: 'Prerender' })).record_count;
			if (loadDone && bCount >= aCount && aCount > 0) break;
			await delay(1000);
		}
		await loadPromise.catch(() => {});

		const aLog = await readLog(A);
		const bLog = await readLog(B);
		const truncations = (aLog.match(/\[blob-truncate-source\] truncated /g) ?? []).length;
		const advancedPast = (bLog.match(/is unrecoverable at source .* advancing the resume cursor past it/g) ?? [])
			.length;
		// Prove it was the INCOMPLETE/500 arm, not an ENOENT/404 one: the forwarded source error text
		// carries core's BlobReadError message for the incomplete path.
		const incompleteErrors = (bLog.match(/Blob (is incomplete|error:[^\n]*incomplete)/gi) ?? []).length;
		console.log(
			`incomplete-source: A=${aCount} B=${bCount} truncations=${truncations} advancedPast=${advancedPast} incompleteErrors=${incompleteErrors}`
		);

		ok(truncations > 0, `expected the source truncate injector to fire at least once, found ${truncations}`);
		// The discriminating assertion: the receiver took the advance branch for a source-reported
		// PERMANENT failure. On unfixed code a 500 stays unclassified — B logs only "Blob save failed
		// for ..." and pins the cursor — so `advancedPast` is 0 and this fails.
		ok(
			advancedPast > 0,
			`receiver never advanced past an incomplete source blob (advancedPast=${advancedPast}); the cursor would wedge (harper-pro#429)`
		);
		ok(
			incompleteErrors > 0,
			`expected at least one incomplete-blob (500) source error to drive the advance, found ${incompleteErrors}`
		);
		// Sanity: the apply loop kept up (records still flow; the wedge is about the cursor, not visibility).
		ok(bCount >= aCount, `B did not converge on record count: ${bCount}/${aCount}`);
	});
});
