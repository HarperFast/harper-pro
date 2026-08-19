/**
 * Leading-duplicate fast-skip orphans the skipped record's blob streams (harper#2226, harper-pro#659).
 *
 * The sender ALWAYS streams a HAS_BLOBS record's blob chunks before the record itself. On the receiver,
 * the only thing that attaches a consumer to a blob's PassThrough — and thus the only thing that ever
 * frees its buffered bytes — is `receiveBlobs`, which runs while DECODING the record.
 *
 * The leading-duplicate fast-skip never decodes the record: it advances the decoder past it and
 * `continue`s. Its comment says
 *
 *     "A skipped record still carries any blob chunks (delivered as their own BLOB_CHUNK messages and
 *      written independently)"
 *
 * but nothing writes them independently. Every skipped record with a file-backed blob leaves a fully
 * buffered, consumer-less PassThrough in `blobsInFlight`, reclaimed only by the `blobsTimer` sweep
 * REPLICATION_BLOBTIMEOUT later — 900 s by default (raised from 120 s), so steady-state occupancy is
 * `skip rate x blob size x 900 s`, and a resumed stream skips its whole re-streamed tail at once.
 *
 * This is the field shape: a node whose resume cursor is pinned (a blob gap, or blobs outstanding)
 * re-streams a large already-applied tail on every reconnect, skips all of it, and orphans one buffered
 * blob per skipped record. It is not base-copy-specific — the skip is gated `!inCopyMode`.
 *
 * Shape (mirrors leadingDuplicateSkip.test.mjs, with file-backed blobs on the records):
 *   1. B subscribes to A while the table is empty, so the blobs arrive as LIVE writes, not a base copy.
 *   2. A mints RECORDS records each carrying a ~225 KB file-backed blob; B applies them.
 *   3. Kill + restart A. B re-subscribes from its persisted cursor and A re-streams the applied tail.
 *   4. Every re-streamed record is an identity tie whose blob file is already complete on B, so the
 *      fast-skip suppresses it — and each re-delivered blob orphans.
 *
 * Asserted: the orphaned, consumer-less buffered bytes stay bounded. Fails on unfixed code, where they
 * sit at one full blob per skipped record until the sweep.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import {
	killHarper,
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { cp, mkdtemp } from 'node:fs/promises';
import { sendOperation, fetchWithRetry, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const RECORDS = Number(process.env.HARPER_TEST_BLOB_RECORDS || '60');
const BLOB_CHUNKS = process.env.HARPER_TEST_BLOB_CHUNKS || '55'; // 55 * 4096 = 225 KB ~= the reported 223 KB
const BLOB_BYTES = Number(BLOB_CHUNKS) * 4096;
// A handful of blobs in flight is the bound the receive path's comment claims (the sender's cap is 5).
const ORPHAN_CEILING_BLOBS = 8;
const ORPHAN_CEILING_BYTES = ORPHAN_CEILING_BLOBS * BLOB_BYTES;
const GAUGE_MS = '250';
const CONNECT_TIMEOUT_MS = 30000;
const CONVERGE_TIMEOUT_MS = 120000;
const POLL_MS = 250;
// How long to watch AFTER the resumed stream goes quiet. Orphans are only reclaimed by the sweep
// (REPLICATION_BLOBTIMEOUT), so anything still held here is held for the whole timeout.
const SETTLE_WATCH_MS = 15000;
const FIXTURE = join(import.meta.dirname ?? module.path, 'fixture-blob-gap-deadlock-source');
// Every Nth blob write on the FOLLOWER fails with ENOENT. One failed blob save latches `hasBlobGap`,
// which pins the follower's durable resume cursor: everything it applies after that point becomes the
// already-applied tail the leader re-streams on the next reconnect. This is the field condition (the
// affected cluster reported thousands of blob replication failures alongside continuous reconnects) and
// it is what makes the re-streamed tail — and so the skip count — large.
const BLOB_FAIL_FIXTURE = join(import.meta.dirname ?? module.path, 'fixture-blob-fail-injector');
const BLOB_FAIL_INTERVAL = process.env.HARPER_TEST_BLOB_FAIL_INTERVAL || '17';

async function startWithFixtures(nodeCtx, fixtures, options) {
	const dataRootDir = await mkdtemp(
		join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
	);
	for (const fixture of fixtures)
		await cp(fixture, join(dataRootDir, 'components', basename(fixture)), { recursive: true, dereference: true });
	nodeCtx.harper = { hostname: nodeCtx.harper.hostname, dataRootDir };
	return startHarper(nodeCtx, options);
}

function startOptions(node, env = {}) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			// trace: the fast-skip engagement line is emitted at trace level.
			logging: { colors: false, console: true, level: 'trace' },
			replication: { securePort: node.hostname + ':9933' },
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_BLOB_CHUNKS: BLOB_CHUNKS, ...env },
	};
}

function parseGauge(log) {
	const samples = [];
	for (const line of log.split('\n')) {
		const at = line.indexOf('[blob-receive-gauge]');
		if (at < 0 || line.includes('db=system') || line.includes('db=undefined')) continue;
		const sample = {};
		for (const [, key, value] of line.slice(at).matchAll(/(\w+)=(\d+)\b/g)) sample[key] = Number(value);
		samples.push(sample);
	}
	return samples;
}

const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';

async function waitForConnected(node) {
	const deadline = Date.now() + CONNECT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const status = await sendOperation(node, { operation: 'cluster_status' }).catch(() => null);
		if ((status?.connections ?? []).some((c) => (c.database_sockets ?? []).some((s) => s.connected))) return true;
		await delay(POLL_MS);
	}
	return false;
}

async function waitForCount(node, expected, timeoutMs = CONVERGE_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	let count = -1;
	while (Date.now() < deadline) {
		const d = await sendOperation(node, { operation: 'describe_table', table: 'Prerender' }).catch(() => null);
		count = d?.record_count ?? count;
		if (count >= expected) return count;
		await delay(POLL_MS);
	}
	return count;
}

suite('Blob orphaned by leading-duplicate fast-skip', { timeout: 600000 }, (ctx) => {
	before(async () => {
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await startWithFixtures(nodeA, [FIXTURE], startOptions(nodeA.harper));
		// B is the receiver under measurement: gauge on, and one blob save in every BLOB_FAIL_INTERVAL
		// fails so its resume cursor is pinned and the resumed stream re-delivers a real tail.
		await startWithFixtures(
			nodeB,
			[FIXTURE, BLOB_FAIL_FIXTURE],
			startOptions(nodeB.harper, {
				HARPER_TEST_BLOB_RECEIVE_GAUGE_MS: GAUGE_MS,
				HARPER_TEST_BLOB_FAIL_INTERVAL: BLOB_FAIL_INTERVAL,
			})
		);
		ctx.nodes = [nodeA.harper, nodeB.harper];
		ctx.startOptionsA = startOptions(nodeA.harper);
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('a skipped leading duplicate must not orphan its blob bytes', async () => {
		const source = ctx.nodes[0];
		const follower = ctx.nodes[1];

		// Subscribe BEFORE any data exists, so the blobs arrive as live writes rather than a base copy
		// (the fast-skip is gated `!inCopyMode`).
		const tokenResp = await sendOperation(source, {
			operation: 'create_authentication_tokens',
			authorization: source.admin,
		});
		for (let i = 0; i < 15; i++) {
			const r = await sendOperation(follower, {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: source.hostname,
				authorization: 'Bearer ' + tokenResp.operation_token,
			}).catch((e) => ({ error: String(e) }));
			if (!r?.error) break;
			await delay(500 * (i + 1));
		}
		ok(await waitForConnected(follower), 'B never connected to A — setup failure, not the defect');

		// Phase 1: mint RECORDS blob-backed records on A (the caching GET writes them) and let them
		// replicate live to B, blobs and all.
		const seeds = [];
		for (let id = 1; id <= RECORDS; id++) seeds.push(fetchWithRetry(source.httpURL + '/Prerender/' + id));
		await Promise.all(seeds);
		const sourceCount = await waitForCount(source, RECORDS);
		ok(sourceCount >= RECORDS, `source holds only ${sourceCount}/${RECORDS} blob records`);
		const followerCount = await waitForCount(follower, RECORDS);
		ok(followerCount >= RECORDS, `follower never received the blob records: ${followerCount}/${RECORDS}`);
		// Let every blob save settle on B so the re-streamed tail is skippable (the skip declines when the
		// stored blob file is missing/incomplete).
		await delay(3000);

		// Phase 2: kill + restart A. B re-subscribes from its persisted cursor; A re-streams the tail.
		await killHarper({ harper: source });
		await delay(800);
		ctx.nodes[0] = (await startHarper({ harper: source }, ctx.startOptionsA)).harper;
		ok(await waitForConnected(follower), 'B never reconnected to the restarted A');

		// Phase 3: let the resumed stream run, then watch the orphans persist after it goes quiet.
		await delay(SETTLE_WATCH_MS);

		const log = await readLog(follower);
		if (process.env.HARPER_TEST_DUMP_LOGS) {
			const { writeFile } = await import('node:fs/promises');
			await writeFile(process.env.HARPER_TEST_DUMP_LOGS + '/follower.log', log);
			await writeFile(process.env.HARPER_TEST_DUMP_LOGS + '/source.log', await readLog(ctx.nodes[0]));
		}
		const samples = parseGauge(log);
		ok(samples.length > 0, 'no [blob-receive-gauge] lines on the follower — instrumentation did not run');
		// The arming line also contains the phrase ("armed leading-duplicate fast-skip"); a real skip does not.
		const skipLines = log.split('\n').filter((l) => l.includes('leading-duplicate fast-skip') && !l.includes('armed'));
		const skipEngaged = skipLines.length > 0;

		// The tail of samples describes the quiet period after the resumed stream finished: anything still
		// buffered there is orphaned, not in transit.
		const quiet = samples.slice(-Math.min(20, samples.length));
		const finalOrphanBytes = quiet.reduce((m, s) => Math.max(m, s.preRecordBytes ?? 0), 0);
		const finalOrphanStreams = quiet.reduce((m, s) => Math.max(m, s.blobsInFlight ?? 0), 0);
		const peakOrphanBytes = samples.reduce((m, s) => Math.max(m, s.peakPreRecordBytes ?? 0), 0);
		const bpPauses = samples.reduce((m, s) => Math.max(m, s.bpPauses ?? 0), 0);

		console.log(
			[
				`records=${RECORDS} blob=${mb(BLOB_BYTES)} records skipped as leading duplicates=${skipLines.length}`,
				`orphaned buffered bytes, ${SETTLE_WATCH_MS / 1000}s after the stream went quiet = ${mb(finalOrphanBytes)}` +
					` (${(finalOrphanBytes / BLOB_BYTES).toFixed(0)} blobs, ${finalOrphanStreams} streams in blobsInFlight)`,
				`peak consumer-less buffered bytes = ${mb(peakOrphanBytes)} (${(peakOrphanBytes / BLOB_BYTES).toFixed(0)} blobs)`,
				`back-pressure pauses taken = ${bpPauses}`,
				`reclaimed only by the blobsTimer sweep, REPLICATION_BLOBTIMEOUT (default 900s) after the last chunk`,
			].join('\n  ')
		);

		ok(
			skipEngaged,
			'the leading-duplicate fast-skip never engaged, so this run does not exercise the defect (check the resume tail)'
		);
		ok(
			finalOrphanBytes <= ORPHAN_CEILING_BYTES,
			`skipped leading duplicates orphaned their blob bytes: ${mb(finalOrphanBytes)} ` +
				`(${(finalOrphanBytes / BLOB_BYTES).toFixed(0)} blobs, ${finalOrphanStreams} consumer-less streams) still ` +
				`buffered ${SETTLE_WATCH_MS / 1000}s after the resumed stream went quiet, past the ${ORPHAN_CEILING_BLOBS}-blob ` +
				`ceiling of ${mb(ORPHAN_CEILING_BYTES)}. Nothing will reclaim them until the blobsTimer sweep fires ` +
				`REPLICATION_BLOBTIMEOUT (default 900s) after their last chunk, so occupancy is skip-rate x blob-size x 900s.`
		);
	});
});
