/**
 * The unconfirmed-send stall net (harper-pro#810) must NOT fire on a healthy leg that goes quiet
 * after a blob-carrying write.
 *
 * `unconfirmedSendWedgeRecovery.test.mjs` proves the net fires when it should, but every case in it
 * uses a blob-free table, so it cannot see this shape. The receiver's COMMITTED_UPDATE for a commit
 * is sent once, COMMITTED_UPDATE_DELAY (2 ms) after the commit, clamped to
 * `min(lastSequenceIdCommitted, lastDurableSequenceId)` — and for a record whose blob is still
 * saving at that point the durable watermark is still the PRE-blob value. When the blob save then
 * drains, the receiver advances the watermark and re-emits an end_txn, but that end_txn is a local
 * message to core: it tells the SENDER nothing. So without the drain-time re-confirmation the
 * sender is left holding `confirmed < sent` on a fully durable leg, `unconfirmedSince` runs, and the
 * next quiet threshold closes a healthy socket with `peer-not-confirming`.
 *
 * Oracle: with the source's threshold set to seconds, an unfixed build closes the leg inside the
 * quiet window; a fixed one never does. The window covers several 30 s back-pressure ticks so
 * "no close" is an observation rather than a race with the first tick.
 *
 * Stress-gated (spawns two Harper child processes) like the other cluster tests.
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, fetchWithRetry, readLog, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';
const DB = 'data';
const TABLE = 'SlowBlob';
// Seconds, not minutes: the point is that the net has every opportunity to fire and still must not.
const SHORT_THRESHOLD_MS = 5_000;
// The check runs on the session's 30 s back-pressure tick, so this covers three evaluations past the
// threshold — enough that "it never fired" is not a race with the first one.
const QUIET_WINDOW_MS = 100_000;
const CONVERGE_TIMEOUT_MS = 120_000;
const CLOSING = /Closing the sending side of/;
// Matches fixture-slow-blob-authoritative: big enough that the receiver's save cannot finish inside
// COMMITTED_UPDATE_DELAY (2 ms), which is what makes the clamped confirmation deterministic.
const BLOB_BYTES = 64 * 1024 * 64;

function nodeConfig(hostname) {
	return {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, console: true, level: 'debug' },
		replication: {
			securePort: hostname + ':9933',
			databases: [DB],
			// Healthy keepalive so nothing else terminates the leg during the quiet window and turns a
			// false negative into a pass.
			pingInterval: 1000,
			pingTimeout: 30_000,
		},
	};
}

// The blob table comes from a component fixture: `Blob` is a schema type, so there is no create_table
// operation that produces one. Pre-installed into the data root so no deploy/restart is needed.
async function startWithBlobFixture(name, hostname) {
	const dataRootDir = await mkdtemp(
		join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
	);
	await cp(
		join(import.meta.dirname, 'fixture-slow-blob-authoritative'),
		join(dataRootDir, 'components', 'fixture-slow-blob-authoritative'),
		{ recursive: true, dereference: true }
	);
	const node = { name, harper: { dataRootDir, hostname } };
	await startHarper(node, {
		config: nodeConfig(hostname),
		env: {
			HARPER_NO_FLUSH_ON_EXIT: true,
			// Set on BOTH nodes: a false fire on either direction of the pair is a failure of this net.
			HARPER_TEST_UNCONFIRMED_SEND_THRESHOLD_MS: String(SHORT_THRESHOLD_MS),
		},
	});
	return node.harper;
}

async function recordCount(node) {
	try {
		const result = await sendOperation(node, { operation: 'describe_table', database: DB, table: TABLE });
		return result.record_count ?? 0;
	} catch {
		return 0;
	}
}

suite(
	'Unconfirmed-send stall does not fire after a blob write (harper-pro#810)',
	{ skip: !STRESS, timeout: 600_000 },
	(ctx) => {
		before(async () => {
			const hostSource = await getNextAvailableLoopbackAddress();
			const hostSubscriber = await getNextAvailableLoopbackAddress();
			ctx.source = await startWithBlobFixture(ctx.name, hostSource);
			ctx.subscriber = await startWithBlobFixture(ctx.name, hostSubscriber);
			ctx.nodes = [ctx.source, ctx.subscriber];
		});

		after(async () => {
			for (const node of ctx.nodes ?? []) {
				await stopNodeProcess(node).catch(() => {});
				await teardownHarper({ harper: node }).catch(() => {});
			}
		});

		test('a quiet leg whose last write carried a blob is left alone', async () => {
			const { source, subscriber } = ctx;

			await sendOperation(subscriber, {
				operation: 'add_node',
				hostname: source.hostname,
				port: 9933,
				isLeader: true,
				rejectUnauthorized: false,
				authorization: source.admin,
			});

			// Join on an EMPTY table, then prove the LIVE leg works with a blob-free record, so the blob write
			// below is a live frame rather than a base-copy one — the copy path confirms through COPY_COMPLETE,
			// which is a different clock — and so a failure here is distinguishable from a leg that never came up.
			await sendOperation(source, {
				operation: 'insert',
				database: DB,
				table: TABLE,
				records: [{ id: 1, name: 'blob-free marker' }],
			});
			await waitForCondition(async () => (await recordCount(subscriber)) === 1, {
				timeoutMs: CONVERGE_TIMEOUT_MS,
				description: 'a blob-free marker to replicate, proving the live leg before the blob write',
			});

			// One ~50 KB file-backed blob record, and the LAST write of the test. Its save is still in flight
			// 2 ms after the commit, which is what makes the receiver's only COMMITTED_UPDATE for it clamp to
			// the pre-blob watermark.
			ok((await fetchWithRetry(source.httpURL + '/SeedSlowBlob/2')).ok, 'seeding the blob record failed');
			await waitForCondition(async () => (await recordCount(subscriber)) === 2, {
				timeoutMs: CONVERGE_TIMEOUT_MS,
				description: 'the blob record to replicate to the subscriber',
			});
			// Bytes too: the leg must be genuinely durable-complete, or "no close" would be trivially true for
			// a leg that never finished the transfer.
			const blob = await fetchWithRetry(subscriber.httpURL + '/SlowBlobPayload/2');
			equal(blob.status, 200, 'the replicated blob is not readable on the subscriber');
			equal((await blob.arrayBuffer()).byteLength, BLOB_BYTES, 'the replicated blob is truncated');

			// Now go quiet. Nothing further is written, so the receiver has no commit left that would carry a
			// fresh confirmation — exactly the field shape.
			const deadline = Date.now() + QUIET_WINDOW_MS;
			while (Date.now() < deadline) {
				await delay(5_000);
				equal(
					CLOSING.test(await readLog(source)),
					false,
					'the stall net closed a healthy leg that had simply gone quiet after a blob write'
				);
			}
			equal(CLOSING.test(await readLog(subscriber)), false, 'the reverse leg was closed by the stall net too');
		});
	}
);
