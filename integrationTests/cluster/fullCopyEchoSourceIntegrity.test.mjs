/**
 * QA-692 regression: replication/DESIGN.md invariant 16 (bulk copies preserve row origin).
 * A joining receiver's reverse full copy echoes the source's own rows back; a sender that
 * re-attributes them to itself makes the echo win the version tie on the name-smaller node,
 * which then re-mints every blob and unlinks its originals — so a receiver crash mid-echo
 * destroys source blobs. Pinned deterministically, no kill race: after a receiver joins and
 * the reverse copy provably runs, the source's blob-store file set must be untouched and
 * both nodes must serve every blob's exact expected bytes.
 */
import { suite, test, before, after } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { concurrent, fetchWithRetry, readLog } from './clusterShared.mjs';

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
			const id = basename(p);
			if (buf.length < HEADER_SIZE) return { id, status: 'too-small' };
			const headerValue = buf.readBigUInt64BE(0);
			const type = Number(headerValue >> 48n);
			const size = Number(headerValue & 0xffffffffffffn);
			const status =
				type === 0xff ? 'error' : type === 0xfe ? 'pending' : buf.length < HEADER_SIZE + size ? 'truncated' : 'ok';
			return { id, status };
		})
		.sort((a, b) => {
			// hex ids numerically; non-hex strays (temp/OS files) last, by name
			const na = parseInt(a.id, 16);
			const nb = parseInt(b.id, 16);
			if (Number.isNaN(na) || Number.isNaN(nb)) {
				if (Number.isNaN(na) && Number.isNaN(nb)) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
				return Number.isNaN(na) ? 1 : -1;
			}
			return na - nb;
		});
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
	if (bytes.length !== BLOB_SIZE) return { id, ok: false, reason: `length=${bytes.length} expected=${BLOB_SIZE}` };
	if (!bytes.equals(expectedBytesForId(id))) return { id, ok: false, reason: 'bytes-mismatch' };
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
		// the echo rewrite only strikes the node whose name sorts below its peer's
		equal(
			ctx.source.hostname < hostnameB,
			true,
			`precondition: source name (${ctx.source.hostname}) must sort below receiver name (${hostnameB}) for the echo to target the source`
		);
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

		// The echo rides the SOURCE's own subscription to the new peer. Per-record watermark advance
		// is suppressed during a copy; only COPY_COMPLETE's end_txn moves lastReceivedVersion to
		// copyStartTime — so a positive value on A's connection to B proves the reverse copy RAN TO
		// COMPLETION, and the no-change assertions below cannot pass vacuously before it.
		const reverseCopyMarker = `Requesting full copy of database data from wss://${ctx.receiver.hostname}:`;
		const connDeadline = Date.now() + 90000;
		let reverseCopyDone = false;
		let reverseCopyRequested = false;
		while (Date.now() < connDeadline && !reverseCopyDone) {
			reverseCopyRequested ||= (await readLog(ctx.source)).includes(reverseCopyMarker);
			const status = await op(ctx.source, { operation: 'cluster_status' });
			const conn = (status.connections ?? []).find((c) => (c.url ?? c.name ?? '').includes(ctx.receiver.hostname));
			reverseCopyDone = (conn?.database_sockets ?? []).some(
				(s) => s.database === 'data' && typeof s.lastReceivedVersion === 'number' && s.lastReceivedVersion > 1
			);
			if (!reverseCopyDone) await delay(500);
		}
		equal(reverseCopyRequested, true, 'source should have requested its reverse full copy from the new peer');
		equal(reverseCopyDone, true, 'the reverse full copy should run to completion (COPY_COMPLETE watermark)');
		// settle, then snapshot twice so a rewrite still in flight cannot slip through
		await delay(10000);
		const postJoin = blobStoreSnapshot(ctx.source.dataRootDir);
		await delay(3000);
		const postJoinStable = blobStoreSnapshot(ctx.source.dataRootDir);
		for (const [label, snapshot] of [
			['post-join', postJoin],
			['post-join+3s', postJoinStable],
		]) {
			deepEqual(
				snapshot,
				preJoin,
				`DEFECT SIGNATURE (QA-692): the source blob store changed after a receiver joined (${label}) — the reverse ` +
					`full copy echoed the source's own rows back and they were re-applied instead of identity-skipped ` +
					`(pre=${JSON.stringify(preJoin)} ${label}=${JSON.stringify(snapshot)})`
			);
		}

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
