/**
 * The unconfirmed-send stall net (harper-pro#810) must NOT fire on a healthy leg (harper-pro#815).
 *
 * `unconfirmedSendWedgeRecovery.test.mjs` proves the net fires when it should, but every case in it uses
 * a blob-free table between two current nodes, so it cannot see either shape here.
 *
 * 1. **A quiet leg whose last write carried a blob.** The receiver's COMMITTED_UPDATE for a commit is
 *    sent once, COMMITTED_UPDATE_DELAY (2 ms) after it, clamped to
 *    `min(lastSequenceIdCommitted, lastDurableSequenceId)` — and for a record whose blob is still saving
 *    that is the PRE-blob watermark. When the save drains, the receiver advances the watermark and
 *    re-emits an end_txn, but that end_txn is a local message to core: it tells the sender nothing.
 *    Without the drain-time re-confirmation the sender holds `confirmed < sent` on a fully durable leg
 *    and closes it on the next threshold.
 * 2. **A peer that predates that re-confirmation.** It confirms once, clamped, and never revises — the
 *    ordinary state of a quiet leg, not a stall — so `peer-not-confirming` is gated on the peer
 *    advertising `blobDrainConfirm`. Without that gate every rolling upgrade churns healthy legs.
 *
 * Oracles, both with the threshold set to seconds so the net has every opportunity to fire: case 1 closes
 * the leg on a build without the drain confirmation; case 2 closes it on a build without the capability
 * gate (the subscriber advertises no capabilities AND suppresses its confirmations, which together are
 * exactly a pre-#810 receiver). Each quiet window covers several 30 s back-pressure ticks, so "it never
 * fired" is an observation rather than a race with the first tick.
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
// COMMITTED_UPDATE_DELAY (2 ms), which is what makes the clamped confirmation deterministic. 50 KB is
// not: over loopback it sometimes lands durable first and the case passes on unfixed code.
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
async function startWithBlobFixture(name, hostname, env) {
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
			...env,
		},
	});
	return node.harper;
}

// `signal` is waitForCondition's deadline: without forwarding it, a probe against a node that accepts the
// request and never answers outlives the deadline it was meant to bound.
async function recordCount(node, signal) {
	try {
		const result = await sendOperation(node, { operation: 'describe_table', database: DB, table: TABLE }, { signal });
		return result.record_count ?? 0;
	} catch {
		return 0;
	}
}

// Bring up a healthy pair, join them, and prove the LIVE leg works with a blob-free record — so the blob
// write is a live frame rather than a base-copy one (the copy path confirms through COPY_COMPLETE, a
// different clock) and so a later failure is distinguishable from a leg that never came up.
async function startConvergedPair(ctx, name, subscriberEnv) {
	const source = await startWithBlobFixture(name, await getNextAvailableLoopbackAddress());
	const subscriber = await startWithBlobFixture(name, await getNextAvailableLoopbackAddress(), subscriberEnv);
	ctx.nodes.push(source, subscriber);

	await sendOperation(subscriber, {
		operation: 'add_node',
		hostname: source.hostname,
		port: 9933,
		isLeader: true,
		rejectUnauthorized: false,
		authorization: source.admin,
	});
	await sendOperation(source, {
		operation: 'insert',
		database: DB,
		table: TABLE,
		records: [{ id: 1, name: 'blob-free marker' }],
	});
	await waitForCondition(async (signal) => (await recordCount(subscriber, signal)) === 1, {
		timeoutMs: CONVERGE_TIMEOUT_MS,
		description: 'a blob-free marker to replicate, proving the live leg before the blob write',
	});
	return { source, subscriber };
}

// Nothing is written after this, so the receiver has no commit left that would carry a fresh
// confirmation — exactly the field shape.
async function assertQuietLegSurvives(source, subscriber, what) {
	const deadline = Date.now() + QUIET_WINDOW_MS;
	while (Date.now() < deadline) {
		await delay(5_000);
		equal(CLOSING.test(await readLog(source)), false, what);
	}
	equal(CLOSING.test(await readLog(subscriber)), false, 'the reverse leg was closed by the stall net too');
}

suite(
	'Unconfirmed-send stall must not fire on a healthy leg (harper-pro#815)',
	{ skip: !STRESS, timeout: 900_000 },
	(ctx) => {
		before(() => {
			ctx.nodes = [];
		});

		after(async () => {
			for (const node of ctx.nodes ?? []) {
				await stopNodeProcess(node).catch(() => {});
				await teardownHarper({ harper: node }).catch(() => {});
			}
		});

		test('a quiet leg whose last write carried a blob is left alone', async () => {
			const { source, subscriber } = await startConvergedPair(ctx, 'blob-quiet');

			// One 4 MiB file-backed blob record, and the LAST write of the test. Its save is still in flight
			// 2 ms after the commit, which is what makes the receiver's only COMMITTED_UPDATE for it clamp to
			// the pre-blob watermark.
			ok((await fetchWithRetry(source.httpURL + '/SeedSlowBlob/2')).ok, 'seeding the blob record failed');
			await waitForCondition(async (signal) => (await recordCount(subscriber, signal)) === 2, {
				timeoutMs: CONVERGE_TIMEOUT_MS,
				description: 'the blob record to replicate to the subscriber',
			});
			// Bytes too: the leg must be genuinely durable-complete, or "no close" would be trivially true for
			// a leg that never finished the transfer.
			const blob = await fetchWithRetry(subscriber.httpURL + '/SlowBlobPayload/2');
			equal(blob.status, 200, 'the replicated blob is not readable on the subscriber');
			equal((await blob.arrayBuffer()).byteLength, BLOB_BYTES, 'the replicated blob is truncated');

			await assertQuietLegSurvives(
				source,
				subscriber,
				'the stall net closed a healthy leg that had simply gone quiet after a blob write'
			);
		});

		test('a peer that predates the drain confirmation is never read as stalled', async () => {
			// A pre-#810 receiver, assembled from the two existing injectors: it advertises no capability bag
			// at all (so `blobDrainConfirm` resolves to 0) and never sends COMMITTED_UPDATE. Both halves are
			// what an old build does after a blob write — confirm once, clamped, never revise — and the sender
			// must draw no conclusion from it.
			const { source, subscriber } = await startConvergedPair(ctx, 'legacy-peer', {
				HARPER_TEST_OMIT_REPLICATION_CAPABILITIES: '1',
				HARPER_TEST_SUPPRESS_COMMITTED_UPDATE_DB: DB,
			});

			await sendOperation(source, {
				operation: 'insert',
				database: DB,
				table: TABLE,
				records: [{ id: 3, name: 'unconfirmed by an old peer' }],
			});
			await waitForCondition(async (signal) => (await recordCount(subscriber, signal)) === 2, {
				timeoutMs: CONVERGE_TIMEOUT_MS,
				description: 'the row to be applied by the un-advertising subscriber (it just never confirms it)',
			});

			await assertQuietLegSurvives(
				source,
				subscriber,
				'the stall net closed a leg whose peer cannot re-confirm — every rolling upgrade would churn'
			);
		});
	}
);
