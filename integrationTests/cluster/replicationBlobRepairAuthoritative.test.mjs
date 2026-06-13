/**
 * Byte-integrity regression guard: a receive-side blob-save failure on an AUTHORITATIVE
 * (non-caching) table must NOT leave a permanently dangling blob after the watermark
 * re-stream + restart. Companion to replicationBlobResyncOnFailure (the caching case).
 *
 * Setup chain:
 *   1. A receive-side blob save fails on B mid-stream. The row still commits, referencing a
 *      node-local blob fileId whose file never landed -> a momentarily dangling reference.
 *   2. The durability watermark (PR #368) holds B's persisted resume cursor at the last
 *      fully-durable txn, so on the next reconnect/restart the leader RE-STREAMS the
 *      disrupted record carrying its blob.
 *   3. The re-streamed record is applied as a normal same-version overwrite, which re-saves
 *      the blob to a fresh node-local fileId and re-points the row at it. The original
 *      fileId is left as a harmless orphan. AuthLocation is authoritative (no sourcedFrom),
 *      so this re-save is the ONLY way the blob can come back -- a read cannot re-source.
 *
 * What this asserts (and why the assertion is byte-integrity, not a repair-log message):
 * an earlier investigation added a dedicated core repair at the identity-tie duplicate-drop
 * in Table._writeUpdate (harper PR #1281) on the theory that the re-stream arrives as an
 * identity-tie duplicate and is dropped, stranding the dangling reference. Empirically, on
 * the watermark-based #368 receive path, that is NOT what happens: across repeated runs the
 * disrupted record's blob is reliably re-saved by the natural same-version overwrite (the
 * audit-walk lookup that gated the tie-branch reliably misses, so the record never reaches
 * the tie-drop), and the dedicated repair branch never fired. The repair was therefore
 * dropped as redundant; this test is the lasting value -- it asserts the OUTCOME (every
 * blob is intact on the authoritative table with the source offline) rather than the
 * mechanism, so it guards the data-integrity guarantee regardless of which code path
 * achieves it.
 *
 * AuthLocation is a plain @table @export with NO sourcedFrom, so a read on B can NOT
 * re-source and mask a missing blob -- which is exactly why the integrity check here can GET
 * the blob bytes (with A stopped) and trust the result. Every record's 50 KB blob must be
 * present, full-size, and byte-for-byte the deterministic content for its id.
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
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

const BLOB_REQUESTS = 80; // /SeedAuthLocation/{n} hits on A -- each writes a 50 KB file-backed blob
// Let the first BLOB_FAIL_SKIP saves succeed so replication persists a durable resume cursor,
// THEN fail BLOB_FAIL_COUNT save(s). The watermark holds the cursor at the last durable txn; the
// restart resyncs from there and the leader re-streams the disrupted record so its blob is re-saved.
const BLOB_FAIL_SKIP = 20;
// Overridable so a no-injector run (BLOB_FAIL_COUNT=0) can confirm plain authoritative
// replication converges, isolating the injector's effect during diagnosis.
const BLOB_FAIL_COUNT = Number.parseInt(process.env.AUTH_REPAIR_FAIL_COUNT ?? '1', 10);
const CHUNK = 1024;
const CHUNKS = 50;
const BLOB_SIZE = CHUNK * CHUNKS;

// Mirrors blobForId in fixture-large-blob-authoritative/resources.js: the deterministic
// 50 KB content for a given id, materialized here so the test can compare the bytes B
// stored against what A streamed. (Kept in the test, not imported from the fixture's
// resources.js, because that module references the Harper `tables` global at load time.)
function expectedBytesForId(id) {
	const seed = Number(id) | 0;
	const out = Buffer.allocUnsafe(BLOB_SIZE);
	for (let c = 0; c < CHUNKS; c++) {
		for (let i = 0; i < CHUNK; i++) out[c * CHUNK + i] = (seed * 131 + c * 31 + i) & 0xff;
	}
	return out;
}

// Heavy/stress-gated: drives 80 file-backed blob saves over replication plus a restart-driven
// re-stream, so it is slow and IO-heavy. Runs in the stress suite alongside the #368 deadlock
// and resync guards. AUTH_REPAIR_RUN remains an accepted opt-in for running it in isolation.
const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';
const RUN = STRESS || process.env.AUTH_REPAIR_RUN === '1';

const LOG_LEVEL = process.env.AUTH_REPAIR_LOG_LEVEL ?? 'warn';
const sharedConfig = (host) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false, console: true, level: LOG_LEVEL },
	replication: { securePort: host + ':9933' },
});

suite('Authoritative-table blob byte-integrity after receive-side save failure', { skip: !RUN, timeout: 180000 }, (ctx) => {
	before(async () => {
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await startHarper(nodeA, { config: sharedConfig(nodeA.harper.hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
		// B carries the transient blob-fail injector so its first blob save in the fault window
		// (after BLOB_FAIL_SKIP successes) fails, modelling a recoverable receive-side fault.
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

		// Deploy the authoritative table + seed endpoint. Deploy to A replicated (so the schema and
		// data replicate to B), AND deploy the same component explicitly to B (local, non-replicated)
		// so B serves the AuthLocation REST export and the AuthLocationImage byte-reader used by the
		// integrity check below -- a replicated deploy installs the schema/data on B but does not
		// reliably install the component's resources.js (the REST serving) there.
		const payload = await targz(join(import.meta.dirname, 'fixture-large-blob-authoritative'));
		await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project: 'large-blob-authoritative',
			payload,
			replicated: true,
			restart: true,
		});
		await sendOperation(ctx.nodes[1], {
			operation: 'deploy_component',
			project: 'large-blob-authoritative',
			payload,
			restart: true,
		});
		await delay(35000);

		if (BLOB_FAIL_COUNT > 0) {
			const bootLog = await readLog(ctx.nodes[1]);
			ok(
				bootLog.includes('[blob-fail-transient] installed'),
				'transient fault injector did not load on B -- test would not exercise the failure path'
			);
		}
	});

	after(async () => {
		if (process.env.AUTH_REPAIR_KEEP_NODES === '1') {
			console.log(
				'[auth-repair] KEEP_NODES set; leaving data dirs:',
				(ctx.nodes ?? []).map((n) => n.dataRootDir)
			);
			if (ctx.nodes) await Promise.all(ctx.nodes.map((n) => killHarper({ harper: n }).catch(() => null)));
			return;
		}
		if (ctx.nodes) await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n }).catch(() => null)));
	});

	test('an authoritative-table blob survives a receive-side save failure + restart (bytes intact, no re-source)', async () => {
		let [A, B] = ctx.nodes;

		// Phase 1: seed the first BLOB_FAIL_SKIP records and let them commit, establishing a durable
		// resume cursor before any failure. Phase 2 then drives the rest; one blob save fails mid-stream.
		let nextId = 0;
		const seed = (n) => fetchWithRetry(A.httpURL + '/SeedAuthLocation/' + n);
		const p1 = concurrent(() => seed(nextId++), 15);
		for (let i = 0; i < BLOB_FAIL_SKIP; i++) await p1.execute();
		await p1.finish();
		await delay(4000);
		const p2 = concurrent(() => seed(nextId++), 15);
		for (let i = BLOB_FAIL_SKIP; i < BLOB_REQUESTS; i++) await p2.execute();
		await p2.finish();

		// Let replication run and the injected blob save fire. Capture A's full count and confirm the
		// injector actually fired (otherwise the test exercises nothing).
		await delay(20000);
		const aCount = (await sendOperation(A, { operation: 'describe_table', table: 'AuthLocation' })).record_count;
		const bCountPre = (await sendOperation(B, { operation: 'describe_table', table: 'AuthLocation' })).record_count;
		const injected = ((await readLog(B)).match(/\[blob-fail-transient\] failing save /g) ?? []).length;
		ok(aCount === BLOB_REQUESTS, `A did not have all ${BLOB_REQUESTS} seeded records (A=${aCount})`);
		ok(injected > 0, `injector never fired (${injected} failures) -- test exercised nothing`);

		// Restart B with the injector disarmed: B re-subscribes from the durable watermark, the leader
		// re-streams the disrupted record, and B re-saves its blob (via the natural same-version
		// overwrite) to a fresh fileId. No wedge: the watermark receive path never blocks the apply loop.
		await killHarper({ harper: B });
		const restartCtx = { name: ctx.name, harper: { dataRootDir: B.dataRootDir, hostname: B.hostname } };
		await startHarper(restartCtx, { config: sharedConfig(B.hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
		ctx.nodes[1] = B = restartCtx.harper;

		for (let r = 0; r < 30; r++) {
			const status = await sendOperation(B, { operation: 'cluster_status' }).catch(() => null);
			if (status?.connections?.some((c) => (c.database_sockets ?? []).some((s) => s.connected))) break;
			await delay(1000);
		}

		// Convergence signal: B drains the re-stream and reaches A's record count (no deadlock, no
		// permanently stalled record). Byte-integrity is the primary assertion below.
		let bCountPost = bCountPre;
		for (let r = 0; r < 120; r++) {
			bCountPost =
				(await sendOperation(B, { operation: 'describe_table', table: 'AuthLocation' }).catch(() => ({})))
					.record_count ?? bCountPost;
			if (r % 10 === 0) console.log(`[auth-repair] post-restart r=${r} B=${bCountPost}/${aCount}`);
			if (bCountPost >= aCount) break;
			await delay(1000);
		}
		console.log(
			`[auth-repair] pre-restart B=${bCountPre}/${aCount}; post-restart B=${bCountPost}/${aCount}; injected=${injected}`
		);
		ok(bCountPost >= aCount, `B did not converge after restart: B=${bCountPost} A=${aCount}`);

		// Integrity signal (PRIMARY): stop A, then GET every record's blob on B. On an authoritative table
		// a read can NOT re-source, so a missing/short/corrupt blob — including the one whose receive-side
		// save was injected to fail — would surface here. Every blob must be the full 50 KB and
		// byte-for-byte the deterministic content for its id. Failures are collected per-id (not aborted on
		// the first) so a dangling/short/mismatched blob is named in the output.
		await killHarper({ harper: A });
		await delay(1000);

		let verified = 0;
		const failures = [];
		for (let id = 0; id < BLOB_REQUESTS; id++) {
			try {
				const resp = await fetchWithRetry(B.httpURL + '/AuthLocation/' + id, { retries: 4 });
				if (resp.status !== 200) {
					failures.push(`id=${id} record-GET status=${resp.status}`);
					continue;
				}
				const rec = await resp.json();
				if (!(rec && rec.image)) {
					failures.push(`id=${id} no image field`);
					continue;
				}
				const blobResp = await fetchWithRetry(B.httpURL + '/AuthLocationImage/' + id, { retries: 4 });
				if (blobResp.status !== 200) {
					failures.push(`id=${id} blob-GET status=${blobResp.status}`);
					continue;
				}
				const bytes = Buffer.from(await blobResp.arrayBuffer());
				if (bytes.length !== BLOB_SIZE) {
					failures.push(`id=${id} length=${bytes.length} expected=${BLOB_SIZE}`);
					continue;
				}
				if (!bytes.equals(expectedBytesForId(id))) {
					failures.push(`id=${id} bytes-mismatch`);
					continue;
				}
				verified++;
			} catch (e) {
				failures.push(`id=${id} threw ${(e && e.message) || e}`);
			}
		}
		console.log(
			`[auth-repair] byte-integrity verified=${verified}/${BLOB_REQUESTS}; failures(${failures.length}): ${failures.join(' | ')}`
		);
		ok(
			verified === BLOB_REQUESTS,
			`verified ${verified}/${BLOB_REQUESTS} blobs intact on B (failures: ${failures.join(', ')})`
		);
	});
});
