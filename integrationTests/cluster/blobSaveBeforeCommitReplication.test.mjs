/**
 * Regression anchor: first live-cluster verification of the harper#1640 / PR #1641 fix.
 * "Replicated blobs created with saveBeforeCommit deadlock the receiver's apply loop"
 * (core commit 807d2e280).
 *
 * Stress-gated: HARPER_RUN_STRESS_TESTS=1 (same gate as blobGapDeadlock, replicationBlobResyncOnFailure).
 *
 * Background: `createBlob(data, { saveBeforeCommit: true })` gates the LOCAL (origin) write's
 * commit on the blob's own durable save. Pre-fix, `pack()` shipped `saveBeforeCommit`/
 * `saveInRecord` over the wire as part of the blob's own spread properties. On the RECEIVER,
 * `startPreCommitBlobsForRecord` is called with `trackPersistedBlobs: true` for source-apply —
 * but the wire-carried `saveBeforeCommit` flag caused it to take the "blobsNeedingSaving" branch
 * (await the blob's own save) instead of the intended "track only" branch. That branch awaits a
 * save whose bytes actually arrive out-of-band via BLOB_CHUNK frames serialized on the same
 * replication socket — which, once the apply queue is over its high-water mark and the socket is
 * paused draining, are queued behind the very frame the apply loop is blocked on. Circular wait,
 * permanent wedge (same family as the receive-path blob-gap deadlock in blobGapDeadlock.test.mjs,
 * but a DIFFERENT trigger: no receive-side save failure needed, just the wire-carried flag itself
 * plus backpressure). The fix (core 807d2e280) strips saveBeforeCommit/saveInRecord at pack()
 * time and checks trackPersistedBlobs FIRST, unconditionally, so the receiver's apply commit never
 * gates on wire-carried save flags.
 *
 * This corner was CODE-CONFIRMED ONLY prior to this test — never exercised on a live cluster.
 * None of the existing blob cluster tests (blobGapDeadlock, replicationBlobResyncOnFailure,
 * addNodeFullCopy, ...) create blobs with saveBeforeCommit:true; this fixture is the first to do so.
 *
 * Scenario:
 *   1. Node A alone; seed PRE_EXISTING saveBeforeCommit records (each a ~64 KB file-backed,
 *      multi-chunk blob) on an AUTHORITATIVE (non-caching) table, SbcLocation.
 *   2. Node B joins A fresh via add_node {isLeader:true} -> triggers a full copy of the
 *      pre-existing records (the "join a node with data already present" shape).
 *   3. While B is still catching up, drive RECORDS more saveBeforeCommit writes on A at
 *      CONCURRENCY concurrency -> live-tails onto the same connection, building apply-queue
 *      backpressure on B.
 *   4. Mid-load, kill and restart B (re-passing its ORIGINAL config, per the gotcha that a
 *      restart without it wipes replication filters) -> the "restart the receiver mid-load" shape.
 *   5. Assert B converges to A's record count, B's on-disk blob file count reaches A's, and a
 *      spot-checked blob read back from B is byte-complete. A convergence timeout (not a process
 *      hang — node:test enforces the suite timeout) IS the deadlock signature on unfixed code.
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, cp } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import {
	startHarper,
	teardownHarper,
	killHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { sendOperation, fetchWithRetry, concurrent, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';
const FIXTURE = join(import.meta.dirname, 'fixture-blob-save-before-commit');
const BLOB_SIZE = 16 * 4096; // must match resources.js CHUNK*CHUNKS

const PRE_EXISTING = Number.parseInt(process.env.HARPER_TEST_QA488_PREEXISTING || '20', 10);
const RECORDS = Number.parseInt(process.env.HARPER_TEST_QA488_RECORDS || '260', 10);
const CONCURRENCY = Number.parseInt(process.env.HARPER_TEST_QA488_CONCURRENCY || '40', 10);
const CONVERGE_TIMEOUT_MS = Number.parseInt(process.env.HARPER_TEST_QA488_CONVERGE_MS || '120000', 10);

function sharedConfig(host) {
	return {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, console: true, level: 'debug', stdStreams: false },
		replication: { securePort: host + ':9933', databases: ['data'] },
	};
}

// Manually stage the fixture into a fresh dataRootDir and start Harper with a PRE-RESERVED
// hostname. setupHarperWithFixture() unconditionally resets ctx.harper = { dataRootDir },
// discarding any pre-set hostname — that would leave the replication config's baked-in host
// mismatched against the address Harper actually self-assigns (see qa521's note on this same
// trap). Doing the copy + startHarper directly avoids it.
async function startFixtureNode(hostname, name, options) {
	const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
	await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true, dereference: true });
	const nodeCtx = { name, harper: { hostname, dataRootDir } };
	await startHarper(nodeCtx, options);
	return nodeCtx.harper;
}

// Count blob files under <dataRootDir>/blobs/<db>/ (layout: blobs/data/<p>/<p>/<fileId>).
function countBlobFiles(dataRootDir, db = 'data') {
	const root = join(dataRootDir, 'blobs', db);
	if (!existsSync(root)) return 0;
	let count = 0;
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) walk(p);
			else count++;
		}
	};
	walk(root);
	return count;
}

suite(
	'saveBeforeCommit blob-replication regression anchor (harper#1640)',
	{ skip: !STRESS, timeout: 300000 },
	(ctx) => {
		before(async () => {
			const hostnameA = await getNextAvailableLoopbackAddress();
			const hostnameB = await getNextAvailableLoopbackAddress();

			ctx.nodeA = await startFixtureNode(hostnameA, ctx.name, {
				config: sharedConfig(hostnameA),
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});

			// Pre-existing data BEFORE B exists at all: exercises full-copy of saveBeforeCommit-created
			// blobs (the "join a node with data already present" shape).
			let nextPreId = 0;
			const preLoad = concurrent(() => fetchWithRetry(ctx.nodeA.httpURL + '/SeedSbcLocation/' + nextPreId++), 10);
			for (let i = 0; i < PRE_EXISTING; i++) await preLoad.execute();
			await preLoad.finish();

			const preCount = (await sendOperation(ctx.nodeA, { operation: 'describe_table', table: 'SbcLocation' }))
				.record_count;
			equal(preCount, PRE_EXISTING, `expected ${PRE_EXISTING} pre-existing records seeded on A, saw ${preCount}`);

			ctx.nodeB = await startFixtureNode(hostnameB, ctx.name, {
				config: sharedConfig(hostnameB),
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});

			// B joins A as leader -> startTime=0 full copy of the pre-existing saveBeforeCommit records,
			// plus live tailing for subsequent writes on the same connection.
			await sendOperation(ctx.nodeB, {
				operation: 'add_node',
				hostname: ctx.nodeA.hostname,
				rejectUnauthorized: false,
				isLeader: true,
				authorization: ctx.nodeA.admin,
			});

			for (let retries = 0; retries < 15; retries++) {
				const status = await Promise.all(
					[ctx.nodeA, ctx.nodeB].map((n) => sendOperation(n, { operation: 'cluster_status' }))
				);
				if (
					status.every((r) => (r.connections ?? []).every((c) => (c.database_sockets ?? []).every((s) => s.connected)))
				)
					break;
				await delay(300 * (retries + 1));
			}
		});

		after(async () => {
			if (ctx.nodeA) await teardownHarper({ harper: ctx.nodeA }).catch(() => null);
			if (ctx.nodeB) await teardownHarper({ harper: ctx.nodeB }).catch(() => null);
		});

		test('sustained saveBeforeCommit writes + full-copy catch-up + receiver restart mid-load converge', async () => {
			let { nodeA: A, nodeB: B } = ctx;

			// Confirm the full-copy of pre-existing records lands on B before piling on live load, so a
			// slow full-copy and a live-load stall stay distinguishable.
			let preCaughtUp = false;
			for (let i = 0; i < 120; i++) {
				const bCount = (await sendOperation(B, { operation: 'describe_table', table: 'SbcLocation' })).record_count;
				if (bCount >= PRE_EXISTING) {
					preCaughtUp = true;
					break;
				}
				await delay(1000);
			}
			ok(preCaughtUp, 'full copy of pre-existing saveBeforeCommit records never landed on B within 120s');

			// Sustained concurrent writes on A drive B's apply queue with wire-carried saveBeforeCommit
			// blobs while B is also mid-catch-up from the full copy.
			let nextId = PRE_EXISTING + 1000; // clear of the pre-existing id range
			let loadDone = false;
			const load = concurrent(() => fetchWithRetry(A.httpURL + '/SeedSbcLocation/' + nextId++), CONCURRENCY);
			const loadPromise = (async () => {
				for (let i = 0; i < RECORDS; i++) await load.execute();
				await load.finish();
				loadDone = true;
			})();

			// Restart B mid-load. Gotcha: a restart MUST re-pass the original config or replication
			// filters are wiped.
			await delay(3000);
			await killHarper({ harper: B });
			const restartCtx = { name: ctx.name, harper: { dataRootDir: B.dataRootDir, hostname: B.hostname } };
			await startHarper(restartCtx, {
				config: sharedConfig(B.hostname),
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});
			ctx.nodeB = B = restartCtx.harper;

			let reconnected = false;
			for (let i = 0; i < 60; i++) {
				const status = await sendOperation(B, { operation: 'cluster_status' }).catch(() => null);
				if (status?.connections?.some((c) => (c.database_sockets ?? []).some((s) => s.connected))) {
					reconnected = true;
					break;
				}
				await delay(1000);
			}
			ok(reconnected, 'B never reconnected to A after the mid-load restart');

			await loadPromise;

			// Poll for full convergence. A timeout here is the deadlock signature: on unfixed code the
			// apply loop wedges permanently and B plateaus short of A no matter how long we wait.
			const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
			let aCount = 0,
				bCount = 0,
				lastB = -1,
				stalledSamples = 0;
			while (Date.now() < deadline) {
				aCount = (await sendOperation(A, { operation: 'describe_table', table: 'SbcLocation' })).record_count;
				bCount = (await sendOperation(B, { operation: 'describe_table', table: 'SbcLocation' })).record_count;
				if (loadDone && bCount >= aCount && aCount > 0) break;
				if (bCount === lastB) stalledSamples++;
				else stalledSamples = 0;
				lastB = bCount;
				await delay(1000);
			}

			const aFiles = countBlobFiles(A.dataRootDir);
			const bFiles = countBlobFiles(B.dataRootDir);

			if (bCount < aCount) {
				const [statusA, statusB] = await Promise.all(
					[A, B].map((n) => sendOperation(n, { operation: 'cluster_status' }).catch((e) => String(e)))
				);
				console.log('saveBeforeCommit anchor STALL cluster_status A:', JSON.stringify(statusA));
				console.log('saveBeforeCommit anchor STALL cluster_status B:', JSON.stringify(statusB));
				console.log('saveBeforeCommit anchor STALL log A (tail):', (await readLog(A)).slice(-4000));
				console.log('saveBeforeCommit anchor STALL log B (tail):', (await readLog(B)).slice(-4000));
			}

			console.log(
				`saveBeforeCommit anchor: A=${aCount} B=${bCount} stalledSamples=${stalledSamples} preExisting=${PRE_EXISTING} ` +
					`blobFiles A=${aFiles} B=${bFiles}`
			);

			ok(
				bCount >= aCount,
				`receiver never converged: B=${bCount}/${aCount} after ${CONVERGE_TIMEOUT_MS}ms (stalled ~${stalledSamples}s) — ` +
					`apply-loop wedge on wire-carried saveBeforeCommit (harper#1640).`
			);
			ok(
				bFiles >= aFiles,
				`B is short blob files after convergence claimed: A=${aFiles} B=${bFiles} — record counts converged but blob bytes did not`
			);

			// Content spot-check: fetch one of the LIVE (post-restart) records back from B and confirm
			// its blob is present and complete-sized, not just that the row metadata replicated.
			const sampleId = PRE_EXISTING + 1000 + RECORDS - 1;
			const imgResp = await fetchWithRetry(B.httpURL + '/SbcLocationImage/' + sampleId, { retries: 10 });
			ok(imgResp.ok, `expected sample record ${sampleId} image readable on B, got ${imgResp.status}`);
			const buf = Buffer.from(await imgResp.arrayBuffer());
			equal(buf.length, BLOB_SIZE, `sample blob on B is truncated/incomplete: ${buf.length} bytes`);
		});
	}
);
