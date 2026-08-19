/**
 * Receive-side blob memory is unbounded: a blob-dense base copy accumulates received-but-not-durable
 * blob bytes at (arrival rate - blob-write rate) with NO flow control (harper-pro#659, harper#2226).
 *
 * The BLOB_CHUNK receive path buffers a blob whose chunks outran its record and deliberately does NOT
 * pause the socket for it — pausing there would strand the very record that attaches the consumer
 * (harper-pro#457). The comment justifying that exemption asserts the exposure is bounded by the
 * sender's in-flight blob cap (`MAX_OUTSTANDING_BLOBS_BEING_SENT`, default 5). It is not:
 *
 *   1. The cap bounds concurrent SENDS. A blob stops counting against it the moment its last chunk is
 *      written to the socket — long before the receiver has written the file.
 *   2. `receiveBlobs` starts `saveBlob(...).saving` per blob with no concurrency or byte cap, and the
 *      stream is DELETED from `blobsInFlight` as it connects, so neither `blobsInFlight.size` nor the
 *      `blobsTimer` sweep can see or reclaim those bytes.
 *   3. A blob small enough to arrive fully within the sender's ahead-of-record window (the reported
 *      case: ~223 KB) can NEVER take back-pressure: it has no further chunks by the time it has a
 *      consumer, so `write()` never returns false on a connected stream.
 *
 * What this test measures, via the `[blob-receive-gauge]` line the receive path emits under
 * HARPER_TEST_BLOB_RECEIVE_GAUGE_MS, is WHERE the retained bytes live. Two classes are counted
 * separately because the fix differs:
 *
 *   preRecordBytes       buffered in `blobsInFlight`, record not yet arrived (the hypothesis in #2226)
 *   unsettledSaveBytes   connected to a `saveBlob` that has not settled, already out of the map
 *
 * The receiver's blob-write path is slowed with HARPER_TEST_BLOB_SAVE_THROTTLE_MS to stand in for a
 * disk that cannot keep up with the network — the reported condition. Set it to 0 to run the control
 * (fast disk), where the peak should stay near the documented bound.
 *
 * Expected on unfixed code: the copy CONVERGES (this is not the #457 wedge) but peak
 * unsettledSaveBytes runs orders of magnitude past the documented 5-blob bound, `bpPauses` stays 0,
 * and per-worker `arrayBuffers` on the receiving worker spikes the way the field report shows.
 * Expected once bounded: peak stays within PEAK_CEILING_BLOBS blobs' worth.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { cp, mkdtemp } from 'node:fs/promises';
import { sendOperation, fetchWithRetry, readLog, getMemoryInfo, peakMemory } from './clusterShared.mjs';

// Preserve the pre-assigned hostname while installing the fixture (see copyModeBlobDeadlock.test.mjs).
async function startWithFixture(nodeCtx, fixturePath, options) {
	const dataRootDir = await mkdtemp(
		join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
	);
	await cp(fixturePath, join(dataRootDir, 'components', basename(fixturePath)), { recursive: true, dereference: true });
	nodeCtx.harper = { hostname: nodeCtx.harper.hostname, dataRootDir };
	return startHarper(nodeCtx, options);
}

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const RECORDS = Number(process.env.HARPER_TEST_BLOB_RECORDS || '300');
const BLOB_CHUNK_BYTES = 4096;
const BLOB_CHUNKS = process.env.HARPER_TEST_BLOB_CHUNKS || '55'; // 55 * 4096 = 225 KB ~= the reported 223 KB
const BLOB_BYTES = Number(BLOB_CHUNKS) * BLOB_CHUNK_BYTES;
// The bound the buffering branch's comment claims: the sender's in-flight blob cap.
const SENDER_INFLIGHT_CAP = 5;
const DOCUMENTED_BOUND_BYTES = SENDER_INFLIGHT_CAP * BLOB_BYTES;
// Generous ceiling for the assertion — 32 blobs, ~6x the documented bound — so it is a statement about
// "bounded at all", not about a specific tuning of whatever bound the fix introduces.
const PEAK_CEILING_BLOBS = 32;
const PEAK_CEILING_BYTES = PEAK_CEILING_BLOBS * BLOB_BYTES;
// Per-chunk delay inserted downstream of the receive PassThrough: the slow blob-write path.
const SAVE_THROTTLE_MS = process.env.HARPER_TEST_BLOB_SAVE_THROTTLE_MS ?? '10';
const GAUGE_MS = '250';
const CONVERGE_TIMEOUT_MS = 240000;
const SEED_CONVERGE_TIMEOUT_MS = 60000;
const POLL_MS = 500;
const FIXTURE = join(import.meta.dirname ?? module.path, 'fixture-blob-gap-deadlock-source');

function sharedConfig(host, extra = {}) {
	return {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, console: true, level: 'debug' },
		replication: { securePort: host + ':9933', ...extra },
	};
}

/** Parse every `[blob-receive-gauge]` line out of a node's log into records of numbers. */
function parseGauge(log) {
	const samples = [];
	for (const line of log.split('\n')) {
		const at = line.indexOf('[blob-receive-gauge]');
		if (at < 0) continue;
		const sample = {};
		for (const [, key, value] of line.slice(at).matchAll(/(\w+)=(\d+)\b/g)) sample[key] = Number(value);
		// The `system` database replicates too; only the user database's copy carries the blobs.
		if (line.includes('db=system')) continue;
		samples.push(sample);
	}
	return samples;
}

const maxOf = (samples, key) => samples.reduce((m, s) => Math.max(m, s[key] ?? 0), 0);
const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';

suite('Receive-side blob memory bound (base copy)', { timeout: 600000 }, (ctx) => {
	before(async () => {
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		// A: source. Mints the file-backed blobs and base-copies them.
		await startWithFixture(nodeA, FIXTURE, {
			config: sharedConfig(nodeA.harper.hostname),
			env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_BLOB_CHUNKS: BLOB_CHUNKS },
		});
		// B: receiver. Gauge on, and a blob-write path slower than the network delivers.
		await startWithFixture(nodeB, FIXTURE, {
			config: sharedConfig(nodeB.harper.hostname),
			env: {
				HARPER_NO_FLUSH_ON_EXIT: true,
				HARPER_TEST_BLOB_CHUNKS: BLOB_CHUNKS,
				HARPER_TEST_BLOB_RECEIVE_GAUGE_MS: GAUGE_MS,
				HARPER_TEST_BLOB_SAVE_THROTTLE_MS: String(SAVE_THROTTLE_MS),
			},
		});
		ctx.nodes = [nodeA.harper, nodeB.harper];

		const seedPromises = [];
		for (let id = 1; id <= RECORDS; id++) seedPromises.push(fetchWithRetry(ctx.nodes[0].httpURL + '/Prerender/' + id));
		await Promise.all(seedPromises);

		// A sourcedFrom GET resolves before its cache-populating write commits, so poll for the real count.
		const seedDeadline = Date.now() + SEED_CONVERGE_TIMEOUT_MS;
		let aRecordCount = -1;
		while (Date.now() < seedDeadline) {
			const aDesc = await sendOperation(ctx.nodes[0], { operation: 'describe_table', table: 'Prerender' }).catch(
				() => null
			);
			aRecordCount = aDesc?.record_count ?? 0;
			if (aRecordCount >= RECORDS) break;
			await delay(POLL_MS);
		}
		ok(aRecordCount >= RECORDS, `source did not materialize blobs: holds ${aRecordCount}/${RECORDS}`);
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n })));
	});

	test('received-but-not-durable blob bytes must stay bounded during a base copy', async () => {
		const tokenResp = await sendOperation(ctx.nodes[0], {
			operation: 'create_authentication_tokens',
			authorization: ctx.nodes[0].admin,
		});
		for (let i = 0; i < 15; i++) {
			const r = await sendOperation(ctx.nodes[1], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				authorization: 'Bearer ' + tokenResp.operation_token,
			}).catch((e) => ({ error: String(e) }));
			if (!r?.error) break;
			await delay(500 * (i + 1));
		}

		// Poll convergence while sampling per-worker memory, so the run reproduces the field measurement
		// (one worker's arrayBuffers spiking while its peers stay flat) from a product API, independent of
		// the in-process gauge.
		const memorySamples = [];
		const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
		let last = -1;
		let converged = false;
		while (Date.now() < deadline) {
			const d = await sendOperation(ctx.nodes[1], { operation: 'describe_table', table: 'Prerender' }).catch(
				() => null
			);
			last = d?.record_count ?? last;
			memorySamples.push(await getMemoryInfo(ctx.nodes[1]));
			if (last >= RECORDS) {
				converged = true;
				break;
			}
			await delay(POLL_MS);
		}

		const receiverLog = await readLog(ctx.nodes[1]);
		if (process.env.HARPER_TEST_DUMP_LOGS) {
			const { writeFile } = await import('node:fs/promises');
			await writeFile(process.env.HARPER_TEST_DUMP_LOGS + '/receiver.log', receiverLog);
		}
		const samples = parseGauge(receiverLog);
		ok(samples.length > 0, 'no [blob-receive-gauge] lines in the receiver log — instrumentation did not run');

		const peakUnsettled = maxOf(samples, 'peakUnsettledSaveBytes');
		const peakPreRecord = maxOf(samples, 'peakPreRecordBytes');
		const completedBeforeRecord = maxOf(samples, 'completedBeforeRecord');
		const bpPauses = maxOf(samples, 'bpPauses');
		const peakInFlightMapSize = maxOf(samples, 'blobsInFlight');
		const peakPendingSavePromises = maxOf(samples, 'pendingSavePromises');
		const { peakRss, peakWorkerHeapExt } = peakMemory(memorySamples);

		// Always report: this test doubles as the measurement that discriminates which class accumulates.
		console.log(
			[
				`records=${last}/${RECORDS} blob=${mb(BLOB_BYTES)} throttle=${SAVE_THROTTLE_MS}ms converged=${converged}`,
				`documented bound (${SENDER_INFLIGHT_CAP} blobs in flight) = ${mb(DOCUMENTED_BOUND_BYTES)}`,
				`peak unsettledSaveBytes  = ${mb(peakUnsettled)}  (${(peakUnsettled / BLOB_BYTES).toFixed(0)} blobs)`,
				`peak preRecordBytes      = ${mb(peakPreRecord)}  (${(peakPreRecord / BLOB_BYTES).toFixed(0)} blobs)`,
				`blobs completed before their record = ${completedBeforeRecord}`,
				`back-pressure pauses taken          = ${bpPauses}`,
				`peak blobsInFlight.size             = ${peakInFlightMapSize}`,
				`peak pending save promises          = ${peakPendingSavePromises}`,
				`peak worker heap+external+AB        = ${mb(peakWorkerHeapExt)}   peak rss = ${mb(peakRss)}`,
			].join('\n  ')
		);

		// The copy must still finish: this is the unbounded-memory defect, NOT the #457 wedge. If it did
		// not converge, the numbers below describe a different failure and should not be read as this one.
		ok(converged, `base copy did not converge: subscriber holds ${last}/${RECORDS} (not the defect under test)`);

		// The heart of it. On unfixed code this fails by orders of magnitude.
		ok(
			peakUnsettled <= PEAK_CEILING_BYTES,
			`receive-side blob memory is unbounded: peak received-but-not-durable blob bytes reached ` +
				`${mb(peakUnsettled)} (${(peakUnsettled / BLOB_BYTES).toFixed(0)} blobs), past the ${PEAK_CEILING_BLOBS}-blob ` +
				`ceiling of ${mb(PEAK_CEILING_BYTES)} and ${(peakUnsettled / DOCUMENTED_BOUND_BYTES).toFixed(0)}x the ` +
				`${mb(DOCUMENTED_BOUND_BYTES)} the buffering branch's comment claims bounds it. ` +
				`${completedBeforeRecord} of ${RECORDS} blobs arrived fully ahead of their record (so no ` +
				`per-stream back-pressure could ever apply to them) and ${bpPauses} back-pressure pauses were taken.`
		);
	});
});
