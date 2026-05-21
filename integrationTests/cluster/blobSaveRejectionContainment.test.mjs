/**
 * Regression guard for the receive-side blob save bug surfaced on the prod node that
 * crashed earlier in May. When `saveBlob` rejects (e.g. `createWriteStream` errors
 * with ENOENT), the rejection was already caught for logging but the *raw* promise
 * was still pushed into `outstandingBlobsToFinish`. A later
 * `await Promise.all(outstandingBlobsToFinish)` inside `end_txn`'s `onCommit` then
 * observed the rejection independently and propagated it out as `uncaughtException`.
 *
 * The fix (harper-pro PR #149) stores the catch-handled promise in
 * `outstandingBlobsToFinish` instead, so `Promise.all` only ever sees a fulfilled
 * promise; the log line stays exactly as before.
 *
 * This test installs a fault-injection component on receiver B that makes every Nth
 * blob save fail with ENOENT, then drives blob-bearing replication from A and
 * asserts:
 *   1. The injection actually fired (otherwise the test is testing nothing).
 *   2. `Blob save failed for <id> from <peer>` is logged per failure (the .catch).
 *   3. `uncaughtException` for those failures NEVER appears in B's log.
 *   4. B is still connected to A and B is still committing new records after the
 *      failures.
 *
 * If you're verifying this test catches the regression, revert
 * harper-pro/replication/replicationConnection.ts `receiveBlobs` to push the raw
 * `finished` promise — assertion 3 should fail with several uncaughtException lines.
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

const FAIL_INTERVAL = 7; // every 7th /blobs/ createWriteStream fails on B
const BLOB_REQUESTS = 400; // /Location/{n} hits — each creates a blob on A → replicates to B

suite('Receive-side blob save rejection containment', { timeout: 180000 }, (ctx) => {
	before(async () => {
		// Bring up A (clean) and B (with the fault-injection component preloaded).
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const sharedConfig = (host) => ({
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, console: true, level: 'debug' },
			replication: { securePort: host + ':9933' },
		});
		await startHarper(nodeA, {
			config: sharedConfig(nodeA.harper.hostname),
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});
		// setupHarperWithFixture copies the fixture into dataRootDir/components/<name>
		// before starting Harper, so the injector is in place by the time replication
		// receivers come up. The env var arms it.
		await setupHarperWithFixture(nodeB, join(import.meta.dirname, 'fixture-blob-fail-injector'), {
			config: sharedConfig(nodeB.harper.hostname),
			env: {
				HARPER_NO_FLUSH_ON_EXIT: true,
				HARPER_TEST_BLOB_FAIL_INTERVAL: String(FAIL_INTERVAL),
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

		// Deploy a blob-bearing component to A. `replicated: true` causes it to be
		// installed on B as well, where the injector + LargeLocation coexist.
		// Using fixture-large-blob-source rather than the shared `fixture/` because
		// the latter's blobs are 7,500 bytes — under Harper's FILE_STORAGE_THRESHOLD
		// (8192) so they're stored inline and never hit createWriteStream on B,
		// defeating this test. LargeLocation produces 50 KB blobs which always
		// go through the file-backed write path.
		const payload = await targz(join(import.meta.dirname, 'fixture-large-blob-source'));
		const deployResp = await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project: 'large-blob-source',
			payload,
			replicated: true,
			restart: true,
		});
		equal(deployResp.message, 'Successfully deployed: large-blob-source, restarting Harper');
		// Give both nodes time to come back up after the restart.
		await delay(35000);

		// Sanity: confirm B logged the injector banner. If this isn't there, the test
		// would silently pass without exercising the failure path.
		const bootLog = await readLog(ctx.nodes[1]);
		ok(
			bootLog.includes('[blob-fail-injector] installed'),
			'fault injector did not load on B — test would not exercise the failure path'
		);
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n })));
	});

	test('blob save ENOENT is logged exactly once and never escapes as uncaughtException', async () => {
		const [A, B] = ctx.nodes;

		// Generate blob-bearing replication traffic by hitting /LargeLocation/{id} on A.
		// Each request triggers `sourcedFrom.get(id)` on A → record + 50 KB streamed
		// blob committed → replicated to B → B's createWriteStream is patched to fail
		// every FAIL_INTERVALth call.
		const { execute, finish } = concurrent(
			() => fetchWithRetry(A.httpURL + '/LargeLocation/' + Math.floor(Math.random() * BLOB_REQUESTS)),
			20
		);
		for (let i = 0; i < BLOB_REQUESTS; i++) await execute();
		await finish();

		// Let replication drain. The fixture's `sourcedFrom.get` deliberately delays
		// inside its async generator so the stream takes some real wall-clock time.
		await delay(8000);

		const log = await readLog(B);

		// Assertion 1: the injector actually injected something (otherwise the rest is moot).
		const injectionMatches = log.match(/\[blob-fail-injector\] /g) ?? [];
		ok(
			injectionMatches.length >= 1,
			`expected the injector to have logged at least once, found ${injectionMatches.length}`
		);

		// Assertion 2: the .catch in receiveBlobs logged per-failure.
		const saveFailedMatches = log.match(/\[error\] \[replication\]: Blob save failed for /g) ?? [];
		ok(saveFailedMatches.length > 0, 'expected at least one `Blob save failed` line — injection did not fire');

		// Assertion 3 — the regression itself: no `uncaughtException` with a blob payload.
		// Match both the bare "uncaughtException" and the typical accompanying "Blob error".
		const uncaughtBlobLines = log
			.split('\n')
			.filter((line) => /uncaughtException/.test(line) && /(Blob|ENOENT.*blobs)/.test(line));
		equal(
			uncaughtBlobLines.length,
			0,
			`blob save failure escaped as uncaughtException ${uncaughtBlobLines.length} time(s):\n` +
				uncaughtBlobLines.slice(0, 5).join('\n')
		);

		// Assertion 4: B is still connected to A and still committing — failures didn't
		// break the channel.
		const status = await sendOperation(B, { operation: 'cluster_status' });
		const aConn = (status.connections ?? []).find((c) => (c.url ?? c.name ?? '').includes(A.hostname));
		ok(aConn, `B should still see A in its cluster_status connections`);
		ok(
			(aConn.database_sockets ?? []).every((s) => s.connected),
			'B should still report A connected on every database socket'
		);

		// Liveness: a fresh write on A should still propagate to B. We check via
		// `describe_table` on both sides — a direct, unambiguous count comparison
		// that doesn't depend on REST routing semantics for a `sourcedFrom` table
		// (where GET on a partial record can re-invoke the cache miss handler).
		const beforeB = (await sendOperation(B, { operation: 'describe_table', table: 'LargeLocation' })).record_count;
		await sendOperation(A, {
			operation: 'upsert',
			database: 'data',
			table: 'LargeLocation',
			records: [{ id: 999_999, name: 'liveness probe' }],
		});
		let liveness = false;
		for (let r = 0; r < 20; r++) {
			const afterB = (await sendOperation(B, { operation: 'describe_table', table: 'LargeLocation' })).record_count;
			if (afterB > beforeB) {
				liveness = true;
				break;
			}
			await delay(500);
		}
		ok(liveness, 'replication remained broken after blob save failures — liveness probe did not arrive on B');

		console.log(
			`blob save containment: ${saveFailedMatches.length} injected ENOENTs, ` +
				`${uncaughtBlobLines.length} escaped as uncaughtException`
		);
	});
});
