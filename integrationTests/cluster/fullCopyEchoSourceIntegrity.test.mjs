/**
 * QA-692 regression (source:gh-pro:537 family). When an empty node B joins via add_node,
 * the mesh is bidirectional: the established source A, having no resume cursor for the new
 * peer, requests a full copy FROM B (by design, harper-pro#426) — so B echoes A's own rows
 * back while B's forward copy is still filling. The bulk-copy sender used to stamp its own
 * nodeId on every copied row, so the echo arrived at A attributed to B; the version tie then
 * fell to the alphabetical node-name tie-break instead of the identity match, and the
 * name-smaller node re-applied its ENTIRE own dataset — re-minting every blob from the
 * peer's stream and deleting its original files. A SIGKILL of B mid-echo left A's committed
 * records referencing permanent pending stubs with the good files already gone (the QA-692
 * nightly failure: source A "corrupt" with 2 unreadable blobs despite never being killed).
 *
 * This test pins the invariant deterministically, with no kill race: after a receiver joins
 * and both directions settle, the source's blob store must be byte-for-byte untouched —
 * same file ids, no deletions, no re-mints — and both nodes must serve every blob's exact
 * expected content. On the unfixed sender this fails on every run (the echo rewrites all of
 * A's blob files).
 */
import { suite, test, before, after } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { concurrent, fetchWithRetry } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const RECORD_COUNT = 12;
const FIXTURE_PATH = join(import.meta.dirname, 'fixture-qa692-blob-authoritative');
const PROJECT = 'qa692-blob-authoritative';
const OP_TIMEOUT_MS = 30000;
const HEADER_SIZE = 8;

// Must match fixture-qa692-blob-authoritative/resources.js blobForId exactly.
const CHUNK = 1024;
const CHUNKS = 1024; // 1 MiB
const BLOB_SIZE = CHUNK * CHUNKS;
function expectedBytesForId(id) {
	const seed = Number(id) | 0;
	const out = Buffer.allocUnsafe(BLOB_SIZE);
	for (let c = 0; c < CHUNKS; c++) {
		for (let i = 0; i < CHUNK; i++) out[c * CHUNK + i] = (seed * 131 + c * 31 + i) & 0xff;
	}
	return out;
}

/** Sorted file-id list + per-file header status for a node's blob store. */
function blobStoreSnapshot(dataRootDir) {
	const root = join(dataRootDir, 'blobs', 'data');
	const files = [];
	if (existsSync(root)) {
		const walk = (dir) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const p = join(dir, entry.name);
				if (entry.isDirectory()) walk(p);
				else files.push(p);
			}
		};
		walk(root);
	}
	return files
		.map((p) => {
			const buf = readFileSync(p);
			const id = p.split('/').pop();
			if (buf.length < HEADER_SIZE) return { id, status: 'too-small' };
			const headerValue = buf.readBigUInt64BE(0);
			const type = Number(headerValue >> 48n);
			const size = Number(headerValue & 0xffffffffffffn);
			const status =
				type === 0xff ? 'error' : type === 0xfe ? 'pending' : buf.length < HEADER_SIZE + size ? 'truncated' : 'ok';
			return { id, status };
		})
		.sort((a, b) => parseInt(a.id, 16) - parseInt(b.id, 16));
}

async function op(node, operation, timeoutMs = OP_TIMEOUT_MS) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const data = await response.json();
	equal(response.status, 200, JSON.stringify(data));
	return data;
}

async function verifyBlobContent(node, id) {
	const resp = await fetchWithRetry(node.httpURL + '/BlobCopyImage/' + id, { retries: 5 });
	if (resp.status !== 200) return { id, ok: false, reason: `status=${resp.status}` };
	const bytes = Buffer.from(await resp.arrayBuffer());
	if (!bytes.equals(expectedBytesForId(id))) return { id, ok: false, reason: `length=${bytes.length}` };
	return { id, ok: true };
}

const sharedConfig = (host) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false, stdStreams: false, console: true, level: 'warn' },
	replication: { securePort: host + ':9933', databases: ['data'] },
});

suite('QA-692: a joining receiver must not rewrite the source blob store', { timeout: 300000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const source = { name: ctx.name, harper: { hostname: hostnameA } };
		await startHarper(source, { config: sharedConfig(hostnameA), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
		ctx.source = source.harper;
		const payload = await targz(FIXTURE_PATH);
		const deployResp = await op(ctx.source, {
			operation: 'deploy_component',
			project: PROJECT,
			payload,
			restart: true,
		});
		equal(deployResp.message, `Successfully deployed: ${PROJECT}, restarting Harper`);
		await delay(15000);
		let nextSeedId = 0;
		const { execute, finish } = concurrent(
			() => fetchWithRetry(ctx.source.httpURL + '/SeedBlobCopyRecord/' + nextSeedId++, { retries: 20 }),
			4
		);
		for (let i = 0; i < RECORD_COUNT; i++) await execute();
		await finish();
		const desc = await op(ctx.source, { operation: 'describe_table', database: 'data', table: 'BlobCopyRecord' });
		equal(desc.record_count, RECORD_COUNT, `expected ${RECORD_COUNT} seeded rows on source`);
	});

	after(async () => {
		await Promise.all(
			[
				ctx.source && teardownHarper({ harper: ctx.source }),
				ctx.receiver && teardownHarper({ harper: ctx.receiver }),
			].filter(Boolean)
		);
	});

	test('full copy converges without touching a single source blob file', async () => {
		const preJoin = blobStoreSnapshot(ctx.source.dataRootDir);
		equal(preJoin.length, RECORD_COUNT, 'sanity: one blob file per seeded record');

		const hostnameB = await getNextAvailableLoopbackAddress();
		const receiverCtx = { name: ctx.name, harper: { hostname: hostnameB } };
		await startHarper(receiverCtx, { config: sharedConfig(hostnameB), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
		ctx.receiver = receiverCtx.harper;
		const payload = await targz(FIXTURE_PATH);
		const deployResp = await op(
			ctx.receiver,
			{ operation: 'deploy_component', project: PROJECT, payload, restart: true },
			30000
		);
		equal(deployResp.message, `Successfully deployed: ${PROJECT}, restarting Harper`);
		await delay(15000);
		await op(ctx.receiver, {
			operation: 'add_node',
			hostname: ctx.source.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: ctx.source.admin,
		});

		const deadline = Date.now() + 120000;
		let count = 0;
		while (Date.now() < deadline) {
			try {
				const desc = await op(ctx.receiver, { operation: 'describe_table', database: 'data', table: 'BlobCopyRecord' });
				count = desc?.record_count ?? 0;
			} catch {
				// receiver briefly unreachable while its copy applies
			}
			if (count >= RECORD_COUNT) break;
			await delay(500);
		}
		equal(count, RECORD_COUNT, 'receiver full copy should converge');
		// Settle window: the reverse copy (source pulling from the new peer) and blob saves run
		// after the forward copy converges; the echo-rewrite this test pins happened in here.
		await delay(10000);

		const postJoin = blobStoreSnapshot(ctx.source.dataRootDir);
		deepEqual(
			postJoin,
			preJoin,
			`DEFECT SIGNATURE (QA-692): the source blob store changed after a receiver joined — the reverse ` +
				`full copy echoed the source's own rows back and they were re-applied instead of identity-skipped ` +
				`(pre=${JSON.stringify(preJoin)} post=${JSON.stringify(postJoin)})`
		);

		const allIds = Array.from({ length: RECORD_COUNT }, (_, i) => i);
		const sourceResults = await Promise.all(allIds.map((id) => verifyBlobContent(ctx.source, id)));
		const receiverResults = await Promise.all(allIds.map((id) => verifyBlobContent(ctx.receiver, id)));
		deepEqual(
			sourceResults.filter((r) => !r.ok),
			[],
			'source must still serve every blob with exact content'
		);
		deepEqual(
			receiverResults.filter((r) => !r.ok),
			[],
			'receiver must serve every blob with exact content'
		);
	});
});
