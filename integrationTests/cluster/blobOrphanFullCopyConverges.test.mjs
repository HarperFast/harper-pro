/**
 * Blob orphan × full-copy convergence (#403/#405/#429, HarperFast/harper#1472).
 *
 * A fresh receiver full-copies (add_node isLeader:true) from a leader whose blob files are gone: some
 * data-table blobs and the hdb_deployment payload of an earlier deploy.
 *
 * Invariant: the receiver advances past each source-missing blob as unrecoverable at the source,
 * finalizes the copy (its copy-finalization watchdog never fires) and stays live.
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { existsSync, readdirSync, rmSync, mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
const COPY_FINALIZE_TIMEOUT_MS = 3000;
// A stalled finalization fires within the 4x progress ceiling plus one escalated (2x) threshold detected at
// up to 2x — 8x in all — after COPY_COMPLETE (COPY_FINALIZE_DEADLINE_MULTIPLE, createCopyFinalizeWatchdog).
const COPY_FINALIZE_FIRE_BOUND_MS = 8 * COPY_FINALIZE_TIMEOUT_MS;

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

function waitForHttp200(node, path, description, timeoutMs = 60_000) {
	return waitForCondition(
		async (signal) => {
			const response = await fetch(node.httpURL + path, { signal }).catch(() => null);
			await response?.body?.cancel().catch(() => {});
			return response?.status === 200;
		},
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
				env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_COPY_FINALIZE_TIMEOUT_MS: String(COPY_FINALIZE_TIMEOUT_MS) },
			}),
		]);
		ctx.nodeA = nodeA.harper;
		ctx.nodeB = nodeB.harper;

		// Deploy the authoritative blob fixture to both nodes (B needs the schema to
		// serve its REST endpoint for record-count checks during the copy). The padding is
		// incompressible so the hdb_deployment payload_blob is file-backed, not stored inline.
		const fixtureCopy = mkdtempSync(join(tmpdir(), 'blob-orphan-fixture-'));
		let payload;
		try {
			cpSync(FIXTURE_PATH, fixtureCopy, { recursive: true });
			writeFileSync(join(fixtureCopy, 'padding.bin'), randomBytes(64 * 1024));
			payload = await targz(fixtureCopy);
		} finally {
			rmSync(fixtureCopy, { recursive: true, force: true });
		}
		for (const node of [ctx.nodeA, ctx.nodeB]) {
			const deployed = await sendOperation(node, {
				operation: 'deploy_component',
				project: 'qa177-blob-ttl-copy',
				payload,
				restart: true,
			});
			if (node === ctx.nodeA) ctx.aDeploymentId = deployed.deployment_id;
			await waitForHttp200(node, '/BlobAsset/', `${node.hostname} to serve the blob fixture`);
		}
		ok(ctx.aDeploymentId, 'deploy_component on A returned no deployment_id');

		// Seed RECORD_COUNT authoritative blob records on A via the fixture's seed endpoint.
		for (let i = 0; i < RECORD_COUNT; i++) {
			await fetchWithRetry(ctx.nodeA.httpURL + '/SeedBlobAsset/' + i, { retries: 10 });
		}

		const aDesc = await sendOperation(ctx.nodeA, { operation: 'describe_table', database: 'data', table: 'BlobAsset' });
		ctx.aRecordCount = aDesc.record_count ?? 0;
		ok(ctx.aRecordCount >= RECORD_COUNT, `A should have at least ${RECORD_COUNT} records, got ${ctx.aRecordCount}`);

		const dataBlobs = walkBlobFiles(ctx.nodeA.dataRootDir, 'data');
		ok(
			dataBlobs.length >= ORPHAN_COUNT,
			`Need at least ${ORPHAN_COUNT} blob files to orphan, found ${dataBlobs.length}`
		);
		const systemBlobs = walkBlobFiles(ctx.nodeA.dataRootDir, 'system');
		ok(systemBlobs.length >= 1, 'Need the deployment payload blob file to orphan, found none');
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

		await sendOperation(nodeB, {
			operation: 'add_node',
			hostname: nodeA.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: nodeA.admin,
		});

		let bCount = 0;
		await waitForCondition(
			async (signal) => {
				const { body } = await postOperation(
					nodeB,
					{ operation: 'describe_table', database: 'data', table: 'BlobAsset' },
					{ signal }
				).catch(() => ({ body: {} }));
				bCount = body?.record_count ?? bCount;
				return bCount >= ctx.aRecordCount;
			},
			{
				timeoutMs: 120_000,
				pollMs: 1000,
				description: () =>
					`B to receive all ${ctx.aRecordCount} records (has ${bCount}); the copy cursor appears pinned by the orphaned blob files`,
			}
		);

		await fetchWithRetry(nodeA.httpURL + '/SeedBlobAsset/' + (RECORD_COUNT + 1000), { retries: 10 });
		await waitForHttp200(nodeB, '/BlobAsset/' + (RECORD_COUNT + 1000), 'a post-copy record to replicate to B');

		// Live rows flow while a copy is still unfinalized, so wait out the watchdog for system and data. This
		// must precede the restarting deploy below, which would clear an unfinalized copy.
		const copyLog = async () => {
			const lines = (await readLog(nodeB)).split('\n');
			return {
				completes: lines.filter((line) => line.includes('bulk copy complete from')).length,
				watchdogFires: lines.filter((line) => line.includes('Copy-finalization watchdog')),
			};
		};
		await waitForCondition(async () => (await copyLog()).completes >= 2, {
			timeoutMs: 30_000,
			description: 'B to receive COPY_COMPLETE for the system and data databases',
		});
		// One COPY_COMPLETE each for system and data. A re-run copy would also be the only way the finalize
		// threshold escalates past the wait below, so it fails here rather than going unwatched.
		await delay(COPY_FINALIZE_FIRE_BOUND_MS + 2000);
		const { completes, watchdogFires } = await copyLog();
		equal(watchdogFires.length, 0, `B's copy did not finalize:\n${watchdogFires.join('\n')}`);
		equal(completes, 2, 'B re-ran a copy after COPY_COMPLETE');

		await waitForOperationPath(nodeA, nodeB.hostname);
		const probe = mkdtempSync(join(tmpdir(), 'post-copy-probe-'));
		let probePayload;
		try {
			writeFileSync(join(probe, 'config.yaml'), "rest: true\ngraphqlSchema:\n  files: '*.graphql'\n");
			writeFileSync(join(probe, 'schema.graphql'), 'type PostCopyProbe @table @export { id: ID @primaryKey }\n');
			probePayload = await targz(probe);
		} finally {
			rmSync(probe, { recursive: true, force: true });
		}
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

		// Restarts and reconnects can log the same skip twice, so count distinct records.
		const skippedRecords = new Set();
		for (const line of (await readLog(nodeB)).split('\n')) {
			const match = / for record (\S+) is unrecoverable at source /.exec(line);
			if (match) skippedRecords.add(match[1]);
		}
		ok(
			skippedRecords.has(ctx.aDeploymentId),
			`B never skipped A's orphaned deployment payload (${ctx.aDeploymentId}); skipped: ${[...skippedRecords]}`
		);
		ok(
			skippedRecords.size >= ORPHAN_COUNT + 1,
			`expected B to skip ${ORPHAN_COUNT} orphaned data records plus the payload, skipped: ${[...skippedRecords]}`
		);
	});
});
