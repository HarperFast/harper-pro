/**
 * Regression guard for receive-side blob data loss under a *transient* blob save
 * failure during replication catch-up (harper-pro: soak-rolling-restarts wedge).
 *
 * Root cause: `receiveBlobs` wraps each blob save promise in `.catch()` (added by
 * PR #149/#337 to stop a rejected save escaping as `uncaughtException`). That makes
 * `await Promise.all(outstandingBlobsToFinish)` inside `end_txn`'s `onCommit` resolve
 * even when a blob save failed, so the apply loop (core `Table.ts`) advanced the
 * persisted replication resume cursor past a record whose blob never landed (and, when
 * the stall also dropped queued records, past whole records). The leader then believed
 * the follower had them, never re-sent them, and they were lost permanently — surviving
 * reconnects/restarts. The companion `blobSaveRejectionContainment` test only proves the
 * channel survives and that *new* writes still arrive; it never checks that the records
 * disrupted by the failure recover, which is exactly the gap this test closes.
 *
 * Fix under test (the resume-cursor clamp): on a receive-side blob save failure the
 * connection refuses to advance its persisted resume cursor past the last fully-durable
 * transaction (committed AND all blobs saved). Records keep flowing live — no teardown,
 * no dropped records — but the cursor is pinned, so the *next* reconnect/restart resumes
 * from that pinned point and the normal stream re-delivers (and re-saves) the disrupted
 * blob. Without the clamp the cursor advances over the missing blob and it is lost
 * permanently, surviving restarts.
 *
 * Setup: A (clean source) and B (fault injector failing one /blobs/ save mid-stream, then
 * succeeding — a transient catch-up fault). Drive blob-bearing replication A→B, confirm the
 * fault fired, then restart B with the injector disarmed (modelling the rolling restart of
 * the soak scenario). On the restart B resumes from the clamped cursor, so the leader
 * re-streams the disrupted record(s) and receiveBlobs re-saves their blobs on the way in.
 *
 * Integrity signal: B's on-disk blob set reaches (and, from the re-stream minting fresh
 * node-local fileIds, exceeds) A's. The re-stream itself is the thing under test — it only
 * happens if the clamp held the cursor back. Pre-fix the cursor advanced past the failed
 * save, the restart re-streams nothing, and B stays permanently short a blob file. We inspect
 * the blob store directly and never GET the records: a read on this caching table would
 * re-source and re-save the missing blob, masking the loss. (Distinct from the row-level blob
 * repair on authoritative tables, which is a separate change and a separate test.)
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
	startHarper,
	teardownHarper,
	killHarper,
	setupHarperWithFixture,
	getNextAvailableLoopbackAddress,
	targz,
} from '@harperfast/integration-testing';
import { sendOperation, fetchWithRetry, concurrent, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const BLOB_REQUESTS = 80; // /LargeLocation/{n} hits on A — each creates a 50 KB file-backed blob
// Let the first BLOB_FAIL_SKIP saves succeed so replication establishes a durable resume cursor, THEN
// fail BLOB_FAIL_COUNT save(s). The connection holds the cursor at the last durable txn and resyncs;
// the reconnect re-requests from that cursor and the leader re-streams the disrupted record's blob.
// (A fault on the very first save would leave no cursor to resync from — not the case under test.)
const BLOB_FAIL_SKIP = 20;
const BLOB_FAIL_COUNT = 1;

const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';

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

const sharedConfig = (host) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false, console: true, level: 'warn' },
	replication: { securePort: host + ':9933' },
});

suite('Receive-side blob resume-cursor clamp on transient save failure', { skip: !STRESS, timeout: 180000 }, (ctx) => {
	before(async () => {
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await startHarper(nodeA, { config: sharedConfig(nodeA.harper.hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
		await setupHarperWithFixture(nodeB, join(import.meta.dirname, 'fixture-blob-fail-transient'), {
			config: sharedConfig(nodeB.harper.hostname),
			env: {
				HARPER_NO_FLUSH_ON_EXIT: true,
				HARPER_TEST_BLOB_FAIL_COUNT: String(BLOB_FAIL_COUNT),
				HARPER_TEST_BLOB_FAIL_SKIP: String(BLOB_FAIL_SKIP),
			},
		});
		ctx.nodes = [nodeA.harper, nodeB.harper];

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

		const payload = await targz(join(import.meta.dirname, 'fixture-large-blob-deterministic'));
		await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project: 'large-blob-deterministic',
			payload,
			replicated: true,
			restart: true,
			ignore_replication_errors: true,
		});
		await delay(35000);

		const bootLog = await readLog(ctx.nodes[1]);
		ok(
			bootLog.includes('[blob-fail-transient] installed'),
			'transient fault injector did not load on B — test would not exercise the failure path'
		);
	});

	after(async () => {
		if (ctx.nodes) await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n }).catch(() => null)));
	});

	test('the resume cursor is clamped at a blob save failure so a restart re-streams the blob, reaching parity', async () => {
		let [A, B] = ctx.nodes;

		// Phase 1: drive the first BLOB_FAIL_SKIP records and let them commit, so replication persists a
		// durable resume cursor (the end_txn carries the batch's max record version) before any failure —
		// the long-running-cluster precondition this scenario models. Phase 2 then fails one blob save
		// mid-stream; the clamp pins the cursor at phase 1's durable point while records keep flowing live.
		let nextId = 0;
		const { execute, finish } = concurrent(() => fetchWithRetry(A.httpURL + '/LargeLocation/' + nextId++), 15);
		for (let i = 0; i < BLOB_FAIL_SKIP; i++) await execute();
		await finish();
		await delay(4000);
		const phase2 = concurrent(() => fetchWithRetry(A.httpURL + '/LargeLocation/' + nextId++), 15);
		for (let i = BLOB_FAIL_SKIP; i < BLOB_REQUESTS; i++) await phase2.execute();
		await phase2.finish();

		// Wait for record-count convergence (records arrive even when a blob save fails — the clamp does
		// not drop records, it only holds the persisted cursor).
		let aCount, bCount;
		for (let r = 0; r < 60; r++) {
			aCount = (await sendOperation(A, { operation: 'describe_table', table: 'LargeLocation' })).record_count;
			bCount = (await sendOperation(B, { operation: 'describe_table', table: 'LargeLocation' })).record_count;
			if (bCount >= aCount && aCount > 0) break;
			await delay(1000);
		}
		ok(aCount > 0 && bCount >= aCount, `record counts did not converge: A=${aCount} B=${bCount}`);

		const injected = ((await readLog(B)).match(/\[blob-fail-transient\] failing save /g) ?? []).length;
		ok(injected > 0, `injector never fired (${injected} failures) — test exercised nothing`);
		console.log(
			`clamp test: injectedFailures=${injected} preRestart blobFiles A=${countBlobFiles(A.dataRootDir)} B=${countBlobFiles(B.dataRootDir)}`
		);

		// Restart B with the injector disarmed (HARPER_TEST_BLOB_FAIL_COUNT omitted, so the reloaded
		// component is inert). This models the soak's rolling restart: B re-subscribes from its persisted
		// resume cursor — which the clamp held at the last fully-durable txn — so the leader re-streams the
		// disrupted record and its blob now saves. Pre-fix the cursor advanced past the gap, so the restart
		// resumes *after* the failed blob and never re-requests it.
		await killHarper({ harper: B });
		const restartCtx = { name: ctx.name, harper: { dataRootDir: B.dataRootDir, hostname: B.hostname } };
		await startHarper(restartCtx, {
			config: sharedConfig(B.hostname),
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});
		ctx.nodes[1] = B = restartCtx.harper;

		// Wait for the cluster to reconnect after the restart.
		for (let r = 0; r < 30; r++) {
			const status = await sendOperation(B, { operation: 'cluster_status' }).catch(() => null);
			if (status?.connections?.some((c) => (c.database_sockets ?? []).some((s) => s.connected))) break;
			await delay(1000);
		}

		// Clamp signal: the resume cursor was held at the last fully-durable txn, so on this restart B
		// re-subscribes from *before* the failed blob and the leader re-streams the disrupted record(s).
		// receiveBlobs re-saves their blobs on the way in, so B's on-disk blob set reaches (and, from the
		// re-stream's fresh node-local fileIds, exceeds) A's. Without the clamp the cursor advanced past the
		// gap, the restart re-streams nothing, and B stays permanently short a blob file (bFiles < aFiles).
		// (A read would re-source and mask the loss on this caching table, so we inspect the blob store
		// directly and never GET the records.)
		let aFiles, bFiles;
		for (let r = 0; r < 90; r++) {
			aFiles = countBlobFiles(A.dataRootDir);
			bFiles = countBlobFiles(B.dataRootDir);
			if (bFiles >= aFiles && aFiles > 0) break;
			await delay(1000);
		}
		console.log(`clamp test: injectedFailures=${injected} postRestart A.blobFiles=${aFiles} B.blobFiles=${bFiles}`);
		ok(
			aFiles > 0 && bFiles >= aFiles,
			`B is missing blob files after a transient save failure + restart — ${aFiles - bFiles} short ` +
				`(A=${aFiles}, B=${bFiles}); the resume cursor advanced past the failed blob instead of being clamped, ` +
				`so the restart never re-streamed it.`
		);
	});
});
