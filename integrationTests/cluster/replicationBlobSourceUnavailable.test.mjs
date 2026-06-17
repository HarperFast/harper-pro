/**
 * Regression guard for the permanent blob-replication WEDGE on an expiration/cache table (harper-pro#403).
 *
 * Mechanism (replication/replicationConnection.ts):
 *   - When the SENDER cannot read a blob to stream it (`sendBlobs` -> `blob.stream()` hits ENOENT —
 *     e.g. the blob was evicted/expired at the source), it forwards a BLOB_CHUNK `error` marker.
 *   - The receiver `stream.destroy()`s the blob stream with that error and `saveBlob` rejects.
 *   - BEFORE the fix, `receiveBlobs` treated every save failure identically: it set `hasBlobGap`, which
 *     pins the persisted resume cursor. On reconnect the source re-streams the SAME blob, hits the same
 *     ENOENT, and the cursor holds again — forever. `blobReplicationFailures` climbs and never drains.
 *   - The fix classifies a source-reported permanent absence (`isUnrecoverableSourceBlobError`) and
 *     advances the cursor PAST it (recorded loudly), leaving the record for backfill (harper-pro#388),
 *     while still HOLDING for genuinely local/transient save faults (the createWriteStream injectors).
 *
 * This is the end-to-end wiring the unit test (unitTests/replication/blobReplicationFailure.test.mjs)
 * cannot cover: source read ENOENT -> `error` marker over the WS -> receiver takes the advance branch.
 * The discriminating signal is B's log: FIXED code emits "advancing the resume cursor past it"; UNFIXED
 * code emits only "Blob save failed for ..." and never advances. Heavy/stress-gated like its sibling
 * blobGapDeadlock.test.mjs.
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
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

const RECORDS = Number.parseInt(process.env.HARPER_TEST_SRC_UNAVAIL_RECORDS || '120', 10);
const REQ_CONCURRENCY = Number.parseInt(process.env.HARPER_TEST_SRC_UNAVAIL_CONCURRENCY || '20', 10);
// Fail reads of a deterministic subset of blobs on the SOURCE (fileId % MODULUS === 0) so those blobs
// are PERMANENTLY unsendable (retries fail too), mirroring a scatter of evicted/expired blobs, while
// the rest replicate normally.
const READ_FAIL_MODULUS = process.env.HARPER_TEST_BLOB_READ_FAIL_MODULUS || '5';
const BLOB_CHUNKS = process.env.HARPER_TEST_BLOB_CHUNKS || '16'; // 16 * 4096 = 64 KB per blob (file-backed)
const CONVERGE_TIMEOUT_MS = Number.parseInt(process.env.HARPER_TEST_SRC_UNAVAIL_CONVERGE_MS || '60000', 10);

const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';

suite('Source-unavailable blob does not permanently wedge replication', { skip: !STRESS, timeout: 300000 }, (ctx) => {
	before(async () => {
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const sharedConfig = (host) => ({
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, console: true, level: 'debug' },
			replication: { securePort: host + ':9933' },
		});
		// A is the SENDER: install the source read-fail injector so a subset of its blobs are unsendable.
		await setupHarperWithFixture(nodeA, join(import.meta.dirname, 'fixture-blob-fail-source-read'), {
			config: sharedConfig(nodeA.harper.hostname),
			env: {
				HARPER_NO_FLUSH_ON_EXIT: true,
				HARPER_TEST_BLOB_CHUNKS: BLOB_CHUNKS,
				HARPER_TEST_BLOB_READ_FAIL_MODULUS: READ_FAIL_MODULUS,
			},
		});
		await startHarper(nodeB, {
			config: sharedConfig(nodeB.harper.hostname),
			env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_BLOB_CHUNKS: BLOB_CHUNKS },
		});
		ctx.nodes = [nodeA.harper, nodeB.harper];

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
			bootLog.includes('[blob-fail-source-read] installed'),
			'source read-fail injector did not load on A — test would not exercise the source-unavailable path'
		);

		// Wait for replication to be LIVE before driving load (same race guard as blobGapDeadlock).
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

	test('receiver advances past a source-unavailable blob instead of wedging the cursor', async () => {
		const [A, B] = ctx.nodes;

		// Drive RECORDS distinct cache misses on A (each mints a new file-backed blob), continuously,
		// so the source's replication send hits the read-fail injector on a subset of blobs.
		let nextId = 0;
		const { execute, finish } = concurrent(() => fetchWithRetry(A.httpURL + '/Prerender/' + nextId++), REQ_CONCURRENCY);
		const loadPromise = (async () => {
			for (let i = 0; i < RECORDS; i++) await execute();
			await finish();
		})();

		// B should keep converging — the apply loop never blocks on blobs — and, critically, take the
		// new advance branch for the source-unavailable blobs rather than holding the cursor forever.
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
		const sourceReadFailures = (aLog.match(/\[blob-fail-source-read\] failing read open/g) ?? []).length;
		const advancedPast = (bLog.match(/is unrecoverable at source .* advancing the resume cursor past it/g) ?? [])
			.length;
		console.log(
			`source-unavailable: A=${aCount} B=${bCount} sourceReadFailures=${sourceReadFailures} advancedPast=${advancedPast}`
		);

		ok(
			sourceReadFailures > 0,
			`expected the source read-fail injector to fire at least once, found ${sourceReadFailures}`
		);
		// The discriminating assertion: the receiver took the advance branch for a source-reported
		// unavailable blob. On unfixed code this branch does not exist — B logs only "Blob save failed
		// for ..." and pins the cursor — so `advancedPast` is 0 and this fails.
		ok(
			advancedPast > 0,
			`receiver never advanced past a source-unavailable blob (advancedPast=${advancedPast}); the cursor would wedge (harper-pro#403)`
		);
		// Sanity: the apply loop kept up (records still flow; the wedge is about the cursor, not visibility).
		ok(bCount >= aCount, `B did not converge on record count: ${bCount}/${aCount}`);
	});
});
