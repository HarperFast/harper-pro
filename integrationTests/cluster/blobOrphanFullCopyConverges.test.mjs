/**
 * Blob orphan × full-copy convergence (regression guard for #403/#405/#429, harper#1337)
 *
 * Scenario: an authoritative blob table (no sourcedFrom) has records whose blob files
 * are deleted from disk on the leader — simulating orphaned blob references arising via
 * TTL-eviction races, partial transfers, or the #1287 multi-worker evict() path.
 * A fresh receiver then joins with isLeader:true, triggering a full copy from scratch.
 *
 * Expected: the sender reports each missing file as a permanent (404) error frame, the receiver
 * advances past each orphan and counts it in blobReplicationFailures, and the copy completes:
 * every record and every non-orphaned blob arrives, and the receiver goes back to "Waiting". The
 * orphaned blobs stay diverged until repair_blob_data backfills them.
 */

import { suite, test, before, after } from 'node:test';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { sendOperation, postOperation, fetchWithRetry, readLog, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const FIXTURE_PATH = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'fixture-blob-orphan-full-copy-converges'
);

// The harper#1337 reproduction: 60 file-backed blobs, a contiguous block of 40 deleted after the
// first few, so records both precede and follow the gap.
const RECORD_COUNT = 60;
const ORPHAN_START = 5;
const ORPHAN_COUNT = 40;

/** Blob files under {dataRootDir}/blobs/{db}/, in file-id (allocation) order. */
function blobFilesInIdOrder(dataRootDir, db = 'data') {
	const root = join(dataRootDir, 'blobs', db);
	if (!existsSync(root)) return [];
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) walk(p);
			else files.push(p);
		}
	};
	walk(root);
	// Paths are <storage>/<id[-9..-6]>/<id[-6..-3]>/<id[-3..]> (hex); rejoining the segments gives the id.
	const fileId = (p) => parseInt(relative(root, p).split(sep).slice(-3).join(''), 16);
	return files.sort((a, b) => fileId(a) - fileId(b));
}

function databaseSockets(status) {
	return (status?.connections ?? []).flatMap((c) => c.database_sockets ?? []);
}

// A probe error (a restarting worker, a non-200 answer) means "not yet"; waitForCondition's deadline decides.
function orUndefined(promise) {
	return promise.catch(() => undefined);
}

function describeBlobAsset(node, signal) {
	return sendOperation(node, { operation: 'describe_table', database: 'data', table: 'BlobAsset' }, { signal });
}

const sharedConfig = (host) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false, console: true, level: 'debug' },
	replication: {
		securePort: host + ':9933',
		databases: ['data'],
	},
});

suite('Blob orphan × full-copy convergence (#403/#405/#429 regression)', { timeout: 300000 }, (ctx) => {
	before(async () => {
		// Node A = leader with pre-existing data + orphaned blob files.
		// Node B = fresh receiver that joins (full copy from scratch).
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };

		await Promise.all(
			[nodeA, nodeB].map((node) =>
				startHarper(node, { config: sharedConfig(node.harper.hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } })
			)
		);
		ctx.nodeA = nodeA.harper;
		ctx.nodeB = nodeB.harper;

		// Deployed rather than installed at boot: setupHarperWithFixture drops the pre-assigned hostname,
		// which the replication securePort above is bound to. B needs the schema to count copied records.
		const payload = await targz(FIXTURE_PATH);
		await Promise.all(
			[ctx.nodeA, ctx.nodeB].map((node) =>
				sendOperation(node, { operation: 'deploy_component', project: 'blob-orphan-copy', payload, restart: true })
			)
		);
		await waitForCondition(async (signal) => await orUndefined(describeBlobAsset(ctx.nodeB, signal)), {
			timeoutMs: 60_000,
			description: 'the BlobAsset table on B',
		});

		// Seed sequentially so blob file ids follow record ids and the deleted block is contiguous in both.
		// A seed can land on a worker that has not restarted onto the component yet; retry until it serves it.
		for (let i = 0; i < RECORD_COUNT; i++) {
			await waitForCondition(
				async (signal) =>
					(await orUndefined(fetchWithRetry(ctx.nodeA.httpURL + '/SeedBlobAsset/' + i, { signal })))?.ok,
				{ timeoutMs: 60_000, description: `seeding record ${i}` }
			);
		}

		let aRecordCount;
		await waitForCondition(
			async (signal) => {
				aRecordCount = (await orUndefined(describeBlobAsset(ctx.nodeA, signal)))?.record_count;
				return aRecordCount === RECORD_COUNT;
			},
			{ timeoutMs: 30_000, description: () => `A to hold ${RECORD_COUNT} records (has ${aRecordCount})` }
		);

		// Exactly one file per record, or the deleted block would not be the records it is meant to be.
		let blobFiles = [];
		await waitForCondition(
			() => {
				blobFiles = blobFilesInIdOrder(ctx.nodeA.dataRootDir, 'data');
				return blobFiles.length === RECORD_COUNT;
			},
			{ timeoutMs: 30_000, description: () => `A to hold ${RECORD_COUNT} blob files (has ${blobFiles.length})` }
		);
		for (const p of blobFiles.slice(ORPHAN_START, ORPHAN_START + ORPHAN_COUNT)) {
			rmSync(p, { force: true });
		}
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }).catch(() => null),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }).catch(() => null),
		]);
	});

	test('full copy with orphaned blobs converges (does not wedge)', async () => {
		const { nodeA, nodeB } = ctx;

		// B joins A as subscriber with isLeader:true → triggers full copy. A's replication listener can
		// still be starting.
		let addNode;
		await waitForCondition(
			async (signal) => {
				addNode = await postOperation(
					nodeB,
					{
						operation: 'add_node',
						hostname: nodeA.hostname,
						rejectUnauthorized: false,
						isLeader: true,
						authorization: nodeA.admin,
					},
					{ signal }
				);
				if (addNode.status === 200) return true;
				if (!/ECONNREFUSED/.test(addNode.body?.error))
					throw new Error(`add_node failed: ${JSON.stringify(addNode.body)}`);
			},
			{ timeoutMs: 30_000, description: () => `add_node to succeed: ${JSON.stringify(addNode?.body)}` }
		);

		let bCount = 0;
		await waitForCondition(
			async (signal) => {
				bCount = (await orUndefined(describeBlobAsset(nodeB, signal)))?.record_count ?? bCount;
				return bCount >= RECORD_COUNT;
			},
			{
				timeoutMs: 120_000,
				pollMs: 1000,
				description: () => `B to receive all ${RECORD_COUNT} records (has ${bCount})`,
			}
		);

		let sockets = [];
		await waitForCondition(
			async (signal) => {
				sockets = databaseSockets(await orUndefined(sendOperation(nodeB, { operation: 'cluster_status' }, { signal })));
				return (
					sockets.length > 0 &&
					sockets.every((s) => s.lastReceivedStatus === 'Waiting' && (s.blobReplicationFailures ?? 0) >= ORPHAN_COUNT)
				);
			},
			{
				timeoutMs: 60_000,
				pollMs: 1000,
				description: () =>
					`B's sockets to settle at Waiting with each orphan counted in blobReplicationFailures: ${JSON.stringify(sockets)}`,
			}
		);

		// The blobs on either side of the gap must still arrive, not fail along with the orphans.
		let bBlobFiles = [];
		await waitForCondition(
			() => {
				bBlobFiles = blobFilesInIdOrder(nodeB.dataRootDir, 'data');
				return bBlobFiles.length === RECORD_COUNT - ORPHAN_COUNT;
			},
			{
				timeoutMs: 30_000,
				description: () =>
					`B to hold the ${RECORD_COUNT - ORPHAN_COUNT} non-orphaned blob files (has ${bBlobFiles.length})`,
			}
		);

		// Records and Waiting are reached even while the cursor is held; only the advance lines prove the
		// orphans were classified as permanent.
		let copyCompleted = false;
		let advancedPast = 0;
		await waitForCondition(
			async () => {
				const bLog = await readLog(nodeB);
				copyCompleted = /bulk copy complete/.test(bLog);
				advancedPast = (bLog.match(/advancing the resume cursor past it/g) ?? []).length;
				return copyCompleted && advancedPast >= ORPHAN_COUNT;
			},
			{
				timeoutMs: 10_000,
				description: () =>
					`B to log COPY_COMPLETE (${copyCompleted}) and advance past each of the ${ORPHAN_COUNT} orphans as a permanent source failure (advanced past ${advancedPast})`,
			}
		);
	});
});
