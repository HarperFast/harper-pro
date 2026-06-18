/**
 * Regression guard for the receive-path blob-gap DEADLOCK (harper-pro).
 *
 * Mechanism (replication/replicationConnection.ts):
 *   - `ws.on('message')` serialized EVERY frame through a single `messageProcessing` promise chain,
 *     so frames were processed strictly one-at-a-time, in order.
 *   - A DATA frame applies per-record backpressure: when the apply queue exceeds
 *     RECEIVE_EVENT_HIGH_WATER_MARK it `await tableSubscriptionToReplicator.waitForDrain()`. While
 *     that awaits, the whole messageProcessing chain is blocked.
 *   - BLOB_CHUNK frames therefore queued behind the paused data frame and were never processed — so
 *     the in-flight blob streams they feed never received their bytes.
 *   - The apply loop's end_txn `onCommit` does `await Promise.all(outstandingBlobsToFinish)` — waiting
 *     for those very blobs.
 *   - Circular wait: onCommit waits for blobs ← blobs wait for BLOB_CHUNK frames ← those frames are
 *     stuck behind the drain-paused data frame ← which waits for the apply queue to drain ← which is
 *     blocked because the apply loop is stuck in onCommit. Permanent wedge.
 *
 * A receive-side blob save FAILURE (injected ENOENT) tears down a blob stream mid-stream and is the
 * trigger that opens the gap while many blobs are in flight and the queue is over its HWM.
 *
 * The fix (async durability watermark) removes the synchronous `await Promise.all(outstandingBlobsToFinish)`
 * from the non-copy onCommit path, so the apply loop NEVER blocks on blob saves — breaking the
 * circular wait at its source. The persisted resume cursor is instead gated on a durability watermark
 * (`lastDurableSequenceId`) that only advances to a committed sequence once its blobs (and all earlier
 * ones) are durably saved; on a save failure the watermark holds so a reconnect re-streams the blob.
 * Backpressure is NOT relaxed and BLOB_CHUNK frames stay on the serialized chain (no off-chain
 * dispatch), so there is no unbounded buffering / OOM and no auth/decode exposure.
 *
 * This uses a CACHING (`sourcedFrom`) blob table — the same shape as the soak's `Prerender` table —
 * to also answer whether the caching path is subject to this deadlock (soak attribution).
 *
 * On UNFIXED code (origin/main) this test DEADLOCKS: B stops converging and never reaches A's record
 * count within the timeout. On FIXED code it converges. Heavy/stress-gated.
 */

import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
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

// Tunables. Defaults are sized to drive B's apply queue past RECEIVE_EVENT_HIGH_WATER_MARK (100)
// while many file-backed blobs are in flight, with a transient blob gap opened in the middle.
// NOTE on BLOB_CHUNKS: blobs must exceed FILE_STORAGE_THRESHOLD (8192) so the receive-side save goes
// through the file write path the injector patches. We default to 16 chunks (~64 KB) rather than a
// very large size: with very large blobs the SENDER-side socket-drain throttle (it caps in-flight
// blobs at MAX_OUTSTANDING_BLOBS_BEING_SENT and waits on `writableNeedDrain`) can throttle the stream
// before the injector's save-count window is even reached on a slow loopback, so the gap never opens
// and the test exercises nothing. ~64 KB is comfortably file-backed, still drives the apply queue,
// and reliably reaches the gap window. Override with HARPER_TEST_BLOB_CHUNKS for heavier runs.
const RECORDS = Number.parseInt(process.env.HARPER_TEST_DEADLOCK_RECORDS || '300', 10);
const REQ_CONCURRENCY = Number.parseInt(process.env.HARPER_TEST_DEADLOCK_CONCURRENCY || '40', 10);
const FAIL_START = process.env.HARPER_TEST_BLOB_FAIL_START || '20';
const FAIL_COUNT = process.env.HARPER_TEST_BLOB_FAIL_COUNT || '8';
const BLOB_CHUNKS = process.env.HARPER_TEST_BLOB_CHUNKS || '16'; // 16 * 4096 = 64 KB per blob (file-backed)
// How long we allow B to converge after load stops. A healthy node drains in seconds; the deadlock
// is permanent, so a generous-but-bounded wait cleanly separates the two.
const CONVERGE_TIMEOUT_MS = Number.parseInt(process.env.HARPER_TEST_DEADLOCK_CONVERGE_MS || '60000', 10);

const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';

suite('Receive-path blob-gap deadlock', { skip: !STRESS, timeout: 300000 }, (ctx) => {
	before(async () => {
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const sharedConfig = (host) => ({
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, console: true, level: 'debug' },
			replication: { securePort: host + ':9933' },
		});
		await startHarper(nodeA, {
			config: sharedConfig(nodeA.harper.hostname),
			env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_BLOB_CHUNKS: BLOB_CHUNKS },
		});
		// B carries the transient blob-fail injector: it fails a bounded window of receive-side blob
		// saves (opening the gap) then recovers, so a healthy node would converge afterward.
		await setupHarperWithFixture(nodeB, join(import.meta.dirname, 'fixture-blob-fail-transient'), {
			config: sharedConfig(nodeB.harper.hostname),
			env: {
				HARPER_NO_FLUSH_ON_EXIT: true,
				HARPER_TEST_BLOB_CHUNKS: BLOB_CHUNKS,
				HARPER_TEST_BLOB_FAIL_START: FAIL_START,
				HARPER_TEST_BLOB_FAIL_COUNT: FAIL_COUNT,
			},
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

		// Deploy the caching blob component to A; `replicated: true` installs it on B too, where the
		// injector + Prerender coexist.
		const payload = await targz(join(import.meta.dirname, 'fixture-blob-gap-deadlock-source'));
		const deployResp = await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project: 'blob-gap-deadlock-source',
			payload,
			replicated: true,
			restart: true,
			ignore_replication_errors: true,
		});
		equal(deployResp.message, 'Successfully deployed: blob-gap-deadlock-source, restarting Harper');
		await delay(35000);

		const bootLog = await readLog(ctx.nodes[1]);
		ok(
			bootLog.includes('[blob-fail-transient] installed'),
			'transient blob-fail injector did not load on B — test would not exercise the gap'
		);

		// The subscription handshake (table definitions → acknowledged → receiving) can take tens of
		// seconds after the deploy/restart; firing the bulk load before B is actually subscribed means
		// the load completes while B is still connecting, and B only receives a partial trickle. Wait
		// for replication to be LIVE by writing a probe record on A (id well outside the test keyspace)
		// and confirming it materializes on B before the test body drives load.
		const probeId = 9_000_000 + Math.floor(Math.random() * 1000);
		await fetchWithRetry(ctx.nodes[0].httpURL + '/Prerender/' + probeId);
		let live = false;
		for (let i = 0; i < 90; i++) {
			// describe_table is the authoritative signal: the probe is durably present on B once its
			// record_count reflects it. (A direct GET on B could be served by B's own caching source,
			// so we don't probe B over HTTP.)
			const bDesc = await sendOperation(ctx.nodes[1], { operation: 'describe_table', table: 'Prerender' });
			if ((bDesc.record_count ?? 0) > 0) {
				live = true;
				break;
			}
			await delay(1000);
		}
		ok(live, 'replication from A to B never went live within 90s — setup race, not a deadlock');
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n })));
	});

	test('blob gap does not permanently wedge the receive loop (caching path converges)', async () => {
		const [A, B] = ctx.nodes;

		// Materialize RECORDS records (each with a file-backed streamed blob, ~64 KB by default) on A by
		// hitting the caching resource, driven CONTINUOUSLY in the background while we poll B's
		// convergence. Distinct ids
		// (not random over a small keyspace) so every request mints a new record/blob and the injector's
		// save-count window is actually reached. Driving load concurrently with the convergence poll
		// keeps A's replication stream continuously fed (rather than committing everything up front and
		// going idle), so a transient receive-side blob gap is opened mid-stream — and, on unfixed code,
		// the receive/apply circular wait has live traffic to wedge against.
		let nextId = 0;
		let loadDone = false;
		const { execute, finish } = concurrent(() => fetchWithRetry(A.httpURL + '/Prerender/' + nextId++), REQ_CONCURRENCY);
		const loadPromise = (async () => {
			for (let i = 0; i < RECORDS; i++) await execute();
			await finish();
			loadDone = true;
		})();

		// Poll until B catches up to A's CURRENT count. A is still being written while load runs, so we
		// compare against a fresh A count each loop and only declare convergence once load has finished
		// AND B has reached A. On unfixed code the receive loop deadlocks: B plateaus and never advances
		// while load is still flowing. On fixed code B tracks A and converges after load completes.
		const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
		let lastB = -1;
		let stalledSamples = 0;
		let bCount = 0;
		let aCount = 0;
		while (Date.now() < deadline) {
			aCount = (await sendOperation(A, { operation: 'describe_table', table: 'Prerender' })).record_count;
			bCount = (await sendOperation(B, { operation: 'describe_table', table: 'Prerender' })).record_count;
			if (loadDone && bCount >= aCount && aCount > 0) break;
			if (bCount === lastB) stalledSamples++;
			else stalledSamples = 0;
			lastB = bCount;
			await delay(1000);
		}
		await loadPromise.catch(() => {}); // settle background load (it normally finishes well before the poll ends)

		const log = await readLog(B);
		const installed = log.includes('[blob-fail-transient] installed');
		const injected = (log.match(/\[blob-fail-transient\] failing save/g) ?? []).length;
		const saveFailed = (log.match(/Blob save failed for /g) ?? []).length;
		console.log(
			`blob-gap deadlock: A=${aCount} B=${bCount} injectorInstalled=${installed} ` +
				`injectedFailures=${injected} blobSaveFailed=${saveFailed} stalledSamples=${stalledSamples}`
		);

		ok(injected > 0, `expected the transient injector to fire at least once, found ${injected}`);
		ok(
			bCount >= aCount,
			`receive loop wedged: B converged to ${bCount}/${aCount} (stalled for ~${stalledSamples}s). ` +
				`This is the blob-gap receive/apply deadlock.`
		);
	});
});
