/**
 * Blob orphan × full-copy convergence (regression guard for #403/#405/#429, harper#1337)
 *
 * Scenario: an authoritative blob table (no sourcedFrom) has records whose blob files
 * are deleted from disk on the leader — simulating orphaned blob references arising via
 * TTL-eviction races, partial transfers, or the #1287 multi-worker evict() path.
 * A fresh receiver then joins with isLeader:true, triggering a full copy from scratch.
 *
 * The regression being guarded (harper#1337):
 *   Before #405 (sender) + #429 (receiver), when the full-copy stream hit a record
 *   whose source blob file was missing, the copy cursor was permanently pinned
 *   (hasBlobGap=true held cursor at lastDurableSequenceId=0): the receiver applied only the
 *   records before the first orphan, sat at lastReceivedStatus "Receiving", and never
 *   reached COPY_COMPLETE.
 *
 * Expected outcome on fixed code:
 *   The sender reports the missing file as a permanent (404) error frame, the receiver
 *   advances past each orphan and counts it in blobReplicationFailures, and the copy
 *   completes: every record arrives and the receiver goes back to "Waiting". The orphaned
 *   blobs stay diverged until repair_blob_data backfills them.
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
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
	return (status.connections ?? []).flatMap((c) => c.database_sockets ?? []);
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
		await waitForCondition(
			async () =>
				(await postOperation(ctx.nodeB, { operation: 'describe_table', database: 'data', table: 'BlobAsset' }))
					.status === 200,
			{ timeoutMs: 60_000, description: 'the BlobAsset table on B' }
		);

		// Seed sequentially so blob file ids follow record ids and the deleted block is contiguous in both.
		// A seed can land on a worker that has not restarted onto the component yet; retry until it serves it.
		for (let i = 0; i < RECORD_COUNT; i++) {
			await waitForCondition(async () => (await fetchWithRetry(ctx.nodeA.httpURL + '/SeedBlobAsset/' + i)).ok, {
				timeoutMs: 60_000,
				description: `seeding record ${i}`,
			});
		}

		ctx.aRecordCount = await waitForCondition(
			async () => {
				const aDesc = await sendOperation(ctx.nodeA, {
					operation: 'describe_table',
					database: 'data',
					table: 'BlobAsset',
				});
				return aDesc.record_count >= RECORD_COUNT && aDesc.record_count;
			},
			{ timeoutMs: 30_000, description: `A to hold ${RECORD_COUNT} records` }
		);

		const blobFiles = await waitForCondition(
			() => {
				const files = blobFilesInIdOrder(ctx.nodeA.dataRootDir, 'data');
				return files.length >= RECORD_COUNT && files;
			},
			{ timeoutMs: 30_000, description: `A to hold ${RECORD_COUNT} blob files` }
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
		// still be starting, so retry through ECONNREFUSED.
		let addNode;
		await waitForCondition(
			async () => {
				addNode = await postOperation(nodeB, {
					operation: 'add_node',
					hostname: nodeA.hostname,
					rejectUnauthorized: false,
					isLeader: true,
					authorization: nodeA.admin,
				});
				if (addNode.status === 200) return true;
				if (!/ECONNREFUSED/.test(addNode.body?.error))
					throw new Error(`add_node failed: ${JSON.stringify(addNode.body)}`);
			},
			{ timeoutMs: 30_000, description: () => `add_node to succeed: ${JSON.stringify(addNode?.body)}` }
		);

		let bCount = 0;
		await waitForCondition(
			async () => {
				const bDesc = await sendOperation(nodeB, {
					operation: 'describe_table',
					database: 'data',
					table: 'BlobAsset',
				}).catch(() => null);
				bCount = bDesc?.record_count ?? bCount;
				return bCount >= ctx.aRecordCount;
			},
			{
				timeoutMs: 120_000,
				pollMs: 1000,
				description: () =>
					`B to receive all ${ctx.aRecordCount} records (has ${bCount}); the copy cursor is pinned by the ${ORPHAN_COUNT} orphaned blob files`,
			}
		);

		let sockets = [];
		await waitForCondition(
			async () => {
				sockets = databaseSockets(await sendOperation(nodeB, { operation: 'cluster_status' }));
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

		const bLog = await readLog(nodeB);
		ok(/bulk copy complete/.test(bLog), 'B never logged COPY_COMPLETE for the full copy');
		const advancedPast = (bLog.match(/advancing the resume cursor past it/g) ?? []).length;
		ok(
			advancedPast >= ORPHAN_COUNT,
			`B should advance past each of the ${ORPHAN_COUNT} orphans as a permanent source failure, advanced past ${advancedPast}`
		);
	});
});
