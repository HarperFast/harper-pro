/**
 * Blob orphan × full-copy convergence (regression guard for #403/#405/#429)
 *
 * Scenario: an authoritative blob table (no sourcedFrom) has records whose blob files
 * are deleted from disk on the leader — simulating orphaned blob references arising via
 * TTL-eviction races, partial transfers, or the #1287 multi-worker evict() path.
 * A fresh receiver then joins with isLeader:true, triggering a full copy from scratch.
 *
 * The regression being guarded:
 *   Before #405 (sender) + #429 (receiver), when the full-copy stream hit a record
 *   whose source blob file was missing, the copy cursor was permanently pinned
 *   (hasBlobGap=true held cursor at lastDurableSequenceId=0), and the receiver never
 *   advanced past the orphaned record — the copy hard-wedged. Non-orphaned records
 *   never arrived.
 *
 * Expected outcome on fixed code:
 *   The sender catches ENOENT and sends an error frame (finished:true, error:…).
 *   The receiver handles it, advances past the orphan, and the copy continues.
 *   Non-orphaned records replicate successfully; the receiver record count reaches the
 *   leader's count. The orphaned blobs remain as a gap (re-requestable on reconnect),
 *   but the copy itself does NOT wedge.
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
	targz,
} from '@harperfast/integration-testing';
import { sendOperation, fetchWithRetry } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..', '..', 'dist', 'bin', 'harper.js'
);

const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';
const FIXTURE_PATH = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'fixture-qa177-blob-ttl-copy'
);

const RECORD_COUNT = 20;
const ORPHAN_COUNT = 3;

/** Walk the blob store under {dataRootDir}/blobs/{db}/. */
function walkBlobFiles(dataRootDir, db = 'data') {
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
	return files;
}

const sharedConfig = (host) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false, console: true, level: 'debug' },
	replication: {
		securePort: host + ':9933',
		databases: ['data'],
	},
});

suite('Blob orphan × full-copy convergence (#403/#405/#429 regression)', { skip: !STRESS, timeout: 300000 }, (ctx) => {
	before(async () => {
		// Node A = leader with pre-existing data + orphaned blob files.
		// Node B = fresh receiver that joins (full copy from scratch).
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();

		const nodeA = { name: ctx.name, harper: { hostname: hostnameA } };
		const nodeB = { name: ctx.name, harper: { hostname: hostnameB } };

		await Promise.all([
			startHarper(nodeA, {
				config: sharedConfig(hostnameA),
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			}),
			startHarper(nodeB, {
				config: sharedConfig(hostnameB),
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			}),
		]);
		ctx.nodeA = nodeA.harper;
		ctx.nodeB = nodeB.harper;

		// Deploy the authoritative blob fixture to both nodes (B needs the schema to
		// serve its REST endpoint for record-count checks during the copy).
		const payload = await targz(FIXTURE_PATH);
		await sendOperation(ctx.nodeA, {
			operation: 'deploy_component',
			project: 'qa177-blob-ttl-copy',
			payload,
			restart: true,
		});
		await delay(20000);
		await sendOperation(ctx.nodeB, {
			operation: 'deploy_component',
			project: 'qa177-blob-ttl-copy',
			payload,
			restart: true,
		});
		await delay(20000);

		// Seed RECORD_COUNT authoritative blob records on A via the fixture's seed endpoint.
		for (let i = 0; i < RECORD_COUNT; i++) {
			await fetchWithRetry(ctx.nodeA.httpURL + '/SeedBlobAsset/' + i, { retries: 10 });
		}
		await delay(3000);

		const aDesc = await sendOperation(ctx.nodeA, { operation: 'describe_table', database: 'data', table: 'BlobAsset' });
		ctx.aRecordCount = aDesc.record_count ?? 0;
		ok(ctx.aRecordCount >= RECORD_COUNT, `A should have at least ${RECORD_COUNT} records, got ${ctx.aRecordCount}`);

		// Orphan ORPHAN_COUNT blob files by deleting them directly from disk —
		// simulates the TTL-eviction-race / partial-transfer orphan scenario.
		const blobFiles = walkBlobFiles(ctx.nodeA.dataRootDir, 'data');
		ok(blobFiles.length >= ORPHAN_COUNT, `Need at least ${ORPHAN_COUNT} blob files to orphan, found ${blobFiles.length}`);
		ctx.orphanedPaths = blobFiles.slice(0, ORPHAN_COUNT);
		for (const p of ctx.orphanedPaths) {
			rmSync(p, { force: true });
		}
		ctx.blobFilesAfterOrphan = walkBlobFiles(ctx.nodeA.dataRootDir, 'data').length;
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }).catch(() => null),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }).catch(() => null),
		]);
	});

	test('full copy with orphaned blobs converges (does not wedge)', async () => {
		const { nodeA, nodeB } = ctx;

		// B joins A as subscriber with isLeader:true → triggers full copy.
		// The copy stream will hit ORPHAN_COUNT records with missing blob files.
		await sendOperation(nodeB, {
			operation: 'add_node',
			hostname: nodeA.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: nodeA.admin,
		});

		// Poll B's record count. CONVERGE = reaches A's count within 120s.
		// WEDGE = copy cursor permanently pinned; timeout fires with B under-count.
		const deadline = Date.now() + 120_000;
		let bCount = 0;
		while (Date.now() < deadline) {
			try {
				const bDesc = await sendOperation(nodeB, { operation: 'describe_table', database: 'data', table: 'BlobAsset' });
				bCount = bDesc.record_count ?? 0;
			} catch {
				// transient during replication setup
			}
			if (bCount >= ctx.aRecordCount) break;
			await delay(1000);
		}

		// PRIMARY: copy must complete — non-orphaned records must have arrived.
		ok(
			bCount >= ctx.aRecordCount,
			`WEDGE detected: B only has ${bCount}/${ctx.aRecordCount} records after 120s full copy. ` +
				`Copy cursor appears permanently pinned by the ${ORPHAN_COUNT} orphaned blob file(s). ` +
				`This is the #403/#429 regression — #405/#429 fixes did NOT prevent the wedge.`
		);
	});
});
