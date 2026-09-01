/**
 * Live-cluster verification of replication blob-codec preservation (harper#2443).
 *
 * Origin A compresses new file-backed blobs (storage.blobs.compression, opt-in). Two receivers
 * subscribe to it:
 *   - B advertises `acceptBlobCodecs: ['deflate']` (the default), and has NO local compression
 *     config. If codec preservation works, A streams the raw stored deflate body and B lands it
 *     verbatim under a DEFLATE header. Because nothing on B itself would ever compress (its config
 *     is absent), a deflate-typed blob file on B that is byte-identical to A's is only possible via
 *     raw pass-through — the on-the-wire assertion without a socket tap.
 *   - C runs with the HARPER_REPLICATION_ACCEPT_BLOB_CODECS=0 kill switch, so it advertises
 *     nothing — the mixed-version/mixed-config shape. A must fall back to today's inflated stream
 *     and C must still converge, storing the blob uncompressed.
 *
 * Both the live-tail path (records written while subscribed) and the catch-up path (a record
 * written before the receivers connected) are exercised; blob sends for both go through the same
 * sendBlobs decision.
 */
import { suite, test, before, after } from 'node:test';
import { equal, deepStrictEqual, ok } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const DB = 'data';
const TABLE = 'CodecBlob';
const HEADER_SIZE = 8;
const UNCOMPRESSED_TYPE = 0;
const DEFLATE_TYPE = 1;
// Deterministic hex noise: about half compressible, so the DEFLATE body itself spans several wire
// chunks (a repeated phrase deflates to a single chunk and never exercises multi-chunk pass-through).
// The string form matters — a string value on a Blob-typed attribute goes through the ordinary write
// path (coerced to a blob in saveBlob's jurisdiction), which is where the compression policy resolves.
function hexNoise(seed, bytes) {
	const chunks = [];
	let digest = createHash('sha256').update(seed).digest();
	for (let produced = 0; produced < bytes; produced += digest.length) {
		chunks.push(digest);
		digest = createHash('sha256').update(digest).digest();
	}
	return Buffer.concat(chunks).subarray(0, bytes).toString('hex');
}
const PAYLOAD_CATCHUP = hexNoise('catch-up payload for codec preservation', 200 * 1024);
const PAYLOAD_LIVE = hexNoise('live-tail payload for codec preservation', 200 * 1024);
const MIN_DEFLATE_BODY = 64 * 1024;

function listBlobFiles(dataRootDir, db = DB) {
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
	return files.sort();
}

// A node's settled blob bodies, keyed for comparison across nodes (fileIds differ per node):
// re-read until two consecutive sweeps agree so a mid-write file is never asserted against.
async function settledBlobFiles(node, expectedCount, { timeoutMs = 90000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let previous;
	while (Date.now() < deadline) {
		const files = listBlobFiles(node.dataRootDir);
		if (files.length >= expectedCount) {
			const snapshot = files.map((file) => readFileSync(file));
			if (
				previous &&
				previous.length === snapshot.length &&
				previous.every((buffer, i) => buffer.equals(snapshot[i]))
			) {
				return snapshot;
			}
			previous = snapshot;
		} else {
			previous = undefined;
		}
		await delay(500);
	}
	throw new Error(`blob files on ${node.hostname} never settled at ${expectedCount}`);
}

function contentOf(fileBuffer) {
	const type = fileBuffer[1];
	const body = fileBuffer.subarray(HEADER_SIZE);
	if (type === DEFLATE_TYPE) return inflateSync(body);
	equal(type, UNCOMPRESSED_TYPE, `unexpected blob header type ${type}`);
	return body;
}

async function waitForRecord(node, id, { timeoutMs = 60000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await sendOperation(
			node,
			{
				operation: 'search_by_id',
				database: DB,
				table: TABLE,
				ids: [id],
				get_attributes: ['id'],
			},
			{ signal: AbortSignal.timeout(10000) }
		).catch(() => null);
		if (Array.isArray(result) && result.some((r) => r?.id === id)) return;
		await delay(400);
	}
	throw new Error(`record ${id} never arrived on ${node.hostname}`);
}

suite('replication preserves the blob codec (harper#2443)', { timeout: 300000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();
		const hostnameC = await getNextAvailableLoopbackAddress();

		const baseConfig = {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true },
		};
		const receiverOptions = (hostname, env = {}) => ({
			config: {
				...baseConfig,
				replication: {
					port: hostname + ':9933',
					securePort: null,
					databases: [DB],
					routes: [{ hostname: hostnameA, port: 9933, replicates: { sends: false, receives: true } }],
				},
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true, ...env },
		});

		const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
		await startHarper(ctxA, {
			config: {
				...baseConfig,
				// the opt-in switch under test: compress new file-backed blobs on the origin
				storage: { blobs: { compression: { default: { codec: 'deflate' } } } },
				replication: { port: hostnameA + ':9933', securePort: null, databases: [DB] },
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});
		ctx.nodeA = ctxA.harper;

		await sendOperation(ctx.nodeA, {
			operation: 'create_table',
			database: DB,
			table: TABLE,
			primary_key: 'id',
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'blob', type: 'Blob' },
			],
		});
		// Written before any receiver exists: replicated via catch-up when they join.
		await sendOperation(ctx.nodeA, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [{ id: 'catchup', blob: PAYLOAD_CATCHUP }],
		});

		const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };
		const ctxC = { name: ctx.name, harper: { hostname: hostnameC } };
		await Promise.all([
			startHarper(ctxB, receiverOptions(hostnameB)),
			// the operational kill switch: C stops advertising, so A must send it inflated bytes
			startHarper(ctxC, receiverOptions(hostnameC, { HARPER_REPLICATION_ACCEPT_BLOB_CODECS: '0' })),
		]);
		ctx.nodeB = ctxB.harper;
		ctx.nodeC = ctxC.harper;

		await Promise.all(
			[ctx.nodeB, ctx.nodeC].map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					database: DB,
					table: TABLE,
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'blob', type: 'Blob' },
					],
				})
			)
		);
	});

	after(async () => {
		await Promise.all(
			[ctx.nodeA, ctx.nodeB, ctx.nodeC].map((node) => node && teardownHarper({ harper: node }).catch(() => null))
		);
	});

	test('an advertising peer receives the compressed body verbatim; a non-advertising peer still converges', async () => {
		const { nodeA, nodeB, nodeC } = ctx;

		// live-tail record, written while both receivers are subscribed
		await sendOperation(nodeA, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [{ id: 'live', blob: PAYLOAD_LIVE }],
		});

		await Promise.all([waitForRecord(nodeB, 'catchup'), waitForRecord(nodeB, 'live')]);
		await Promise.all([waitForRecord(nodeC, 'catchup'), waitForRecord(nodeC, 'live')]);

		const filesA = await settledBlobFiles(nodeA, 2);
		const filesB = await settledBlobFiles(nodeB, 2);
		const filesC = await settledBlobFiles(nodeC, 2);

		// Origin stored both blobs compressed, and their content round-trips.
		for (const file of filesA) {
			equal(file[1], DEFLATE_TYPE, 'origin must store the blob deflate-compressed');
			ok(file.length - HEADER_SIZE > MIN_DEFLATE_BODY, `deflate body must span several wire chunks (${file.length})`);
		}
		deepStrictEqual(
			filesA.map((file) => contentOf(file).length).sort((x, y) => x - y),
			[PAYLOAD_CATCHUP.length, PAYLOAD_LIVE.length].sort((x, y) => x - y)
		);

		// The advertising receiver stored the sender's bytes verbatim — deflate header included —
		// even though its own config would never compress: only raw pass-through can produce this.
		for (const file of filesB) equal(file[1], DEFLATE_TYPE, 'advertising receiver must land the stored codec');
		const bodySet = (files) => files.map((file) => file.toString('base64')).sort();
		deepStrictEqual(bodySet(filesB), bodySet(filesA), 'receiver files must be byte-identical to the sender files');

		// The kill-switched receiver got today's inflated stream and stored plain content.
		for (const file of filesC) equal(file[1], UNCOMPRESSED_TYPE, 'non-advertising receiver must store uncompressed');
		const contentSet = (files) => files.map((file) => contentOf(file).toString('base64')).sort();
		deepStrictEqual(contentSet(filesC), contentSet(filesA), 'kill-switched receiver content must still converge');
	});
});
