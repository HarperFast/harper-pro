/**
 * Blob orphan × full-copy convergence (regression guard for #403/#405/#429 and HarperFast/harper#1472)
 *
 * Scenario: an authoritative blob table (no sourcedFrom) has records whose blob files
 * are deleted from disk on the leader — simulating orphaned blob references arising via
 * TTL-eviction races, partial transfers, or the #1287 multi-worker evict() path. The
 * leader's system.hdb_deployment payload blob (from an earlier deploy) is deleted too.
 * A fresh receiver then joins with isLeader:true, triggering a full copy from scratch.
 *
 * The regression being guarded:
 *   Before #405 (sender) + #429 (receiver), when the full-copy stream hit a record
 *   whose source blob file was missing, the copy cursor was permanently pinned
 *   (hasBlobGap=true held cursor at lastDurableSequenceId=0), and the receiver never
 *   advanced past the orphaned record — the copy hard-wedged. Non-orphaned records
 *   never arrived. harper#1472 reported the deploy_component form of it: a peer that
 *   full-copied past a missing payload blob never received a later deployment row, so
 *   awaitDeploymentRow timed out.
 *
 * Expected outcome on fixed code:
 *   The sender catches ENOENT and sends an error frame (finished:true, error:…).
 *   The receiver classifies it as unrecoverable at the source, advances past the orphan,
 *   finishes the copy and goes live: every record arrives, a record written after the
 *   copy replicates, and a later replicated deploy_component succeeds on the receiver.
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { existsSync, readdirSync, rmSync, mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import {
	sendOperation,
	postOperation,
	fetchWithRetry,
	readLog,
	waitForCondition,
	waitForOperationPath,
} from './clusterShared.mjs';

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

const RECORD_COUNT = 20;
const ORPHAN_COUNT = 3;

/** Walk the blob store under {dataRootDir}/blobs/{db}/. */
function walkBlobFiles(dataRootDir, db) {
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
	replication: { securePort: host + ':9933' },
});

/** Resolves once `path` answers 200 on `node` (a transient fetch failure or non-200 keeps polling). */
function waitForHttp200(node, path, description, timeoutMs = 60_000) {
	return waitForCondition(
		async (signal) => (await fetch(node.httpURL + path, { signal }).catch(() => null))?.status === 200,
		{ timeoutMs, description }
	);
}

suite('Blob orphan × full-copy convergence (#403/#405/#429, harper#1472)', { timeout: 300000 }, (ctx) => {
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
		// serve its REST endpoint for record-count checks during the copy). The padding is
		// incompressible so the hdb_deployment payload_blob is file-backed, not stored inline.
		const fixtureCopy = mkdtempSync(join(tmpdir(), 'blob-orphan-fixture-'));
		cpSync(FIXTURE_PATH, fixtureCopy, { recursive: true });
		writeFileSync(join(fixtureCopy, 'padding.bin'), randomBytes(64 * 1024));
		const payload = await targz(fixtureCopy);
		rmSync(fixtureCopy, { recursive: true, force: true });
		for (const node of [ctx.nodeA, ctx.nodeB]) {
			await sendOperation(node, {
				operation: 'deploy_component',
				project: 'qa177-blob-ttl-copy',
				payload,
				restart: true,
			});
			await waitForHttp200(node, '/BlobAsset/', `${node.hostname} to serve the blob fixture`);
		}

		// Seed RECORD_COUNT authoritative blob records on A via the fixture's seed endpoint.
		for (let i = 0; i < RECORD_COUNT; i++) {
			await fetchWithRetry(ctx.nodeA.httpURL + '/SeedBlobAsset/' + i, { retries: 10 });
		}

		const aDesc = await sendOperation(ctx.nodeA, { operation: 'describe_table', database: 'data', table: 'BlobAsset' });
		ctx.aRecordCount = aDesc.record_count ?? 0;
		ok(ctx.aRecordCount >= RECORD_COUNT, `A should have at least ${RECORD_COUNT} records, got ${ctx.aRecordCount}`);

		// Orphan ORPHAN_COUNT data blob files and every system blob file (the deployment
		// payload) by deleting them directly from disk.
		const dataBlobs = walkBlobFiles(ctx.nodeA.dataRootDir, 'data');
		ok(
			dataBlobs.length >= ORPHAN_COUNT,
			`Need at least ${ORPHAN_COUNT} blob files to orphan, found ${dataBlobs.length}`
		);
		const systemBlobs = walkBlobFiles(ctx.nodeA.dataRootDir, 'system');
		ok(systemBlobs.length >= 1, 'Need the deployment payload blob file to orphan, found none');
		ctx.orphanCount = ORPHAN_COUNT + systemBlobs.length;
		for (const p of [...dataBlobs.slice(0, ORPHAN_COUNT), ...systemBlobs]) {
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

		// B joins A as subscriber with isLeader:true → triggers full copy.
		// The copy stream will hit the orphaned records with missing blob files.
		await sendOperation(nodeB, {
			operation: 'add_node',
			hostname: nodeA.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: nodeA.admin,
		});

		// WEDGE = copy cursor permanently pinned; the wait times out with B under-count.
		let bCount = 0;
		await waitForCondition(
			async (signal) => {
				const { body } = await postOperation(
					nodeB,
					{ operation: 'describe_table', database: 'data', table: 'BlobAsset' },
					{ signal }
				).catch(() => ({ body: {} }));
				bCount = body.record_count ?? bCount;
				return bCount >= ctx.aRecordCount;
			},
			{
				timeoutMs: 120_000,
				pollMs: 1000,
				description: () =>
					`B to receive all ${ctx.aRecordCount} records (has ${bCount}); the copy cursor appears pinned by the orphaned blob files`,
			}
		);

		// A record written after the copy reaches B only once B has left copy mode.
		await fetchWithRetry(nodeA.httpURL + '/SeedBlobAsset/' + (RECORD_COUNT + 1000), { retries: 10 });
		await waitForHttp200(nodeB, '/BlobAsset/' + (RECORD_COUNT + 1000), 'a post-copy record to replicate to B');

		// The harper#1472 symptom: a replicated deploy whose peer waits on its hdb_deployment row.
		await waitForOperationPath(nodeA, nodeB.hostname);
		const probe = mkdtempSync(join(tmpdir(), 'post-copy-probe-'));
		writeFileSync(join(probe, 'config.yaml'), "rest: true\ngraphqlSchema:\n  files: '*.graphql'\n");
		writeFileSync(join(probe, 'schema.graphql'), 'type PostCopyProbe @table @export { id: ID @primaryKey }\n');
		const probePayload = await targz(probe);
		rmSync(probe, { recursive: true, force: true });
		const { status, body } = await postOperation(nodeA, {
			operation: 'deploy_component',
			project: 'post-copy-probe',
			payload: probePayload,
			replicated: true,
			restart: true,
		});
		equal(status, 200, JSON.stringify(body));
		const peer = body.replicated?.find((result) => result.node === nodeB.hostname);
		ok(peer && !peer.error, `B did not report a successful deploy: ${JSON.stringify(body)}`);
		await waitForHttp200(nodeB, '/PostCopyProbe/', 'the post-copy component to serve on B');

		// The copy met every orphan and skipped it as unrecoverable at the source.
		const skips = (await readLog(nodeB)).split('\n').filter((line) => line.includes('is unrecoverable at source'));
		ok(
			skips.length >= ctx.orphanCount,
			`expected B to skip ${ctx.orphanCount} source-missing blobs, saw ${skips.length}:\n${skips.join('\n')}`
		);
	});
});
