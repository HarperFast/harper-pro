/**
 * Consumer-less blob-backpressure receive deadlock — the base-copy wedge that survives the copy-mode
 * async-watermark fix (the customer 5.1.x `system` base-copy wedge that 5.1.8 did NOT clear).
 *
 * When a blob's BLOB_CHUNK frames outrun its record, the receive loop creates the blob's PassThrough on
 * the first chunk but has NO consumer for it yet: `saveBlob` (the only thing that drains the PassThrough)
 * is started by `receiveBlobs` only when the RECORD is decoded (`stream.connectedToBlob = true`). If the
 * chunks fill that consumer-less PassThrough past its HWM, `stream.write()` returns false and the receive
 * loop does `ws.pause()` to wait for a `drain` — but that drain can only come from the consumer, which is
 * attached by the very record now blocked behind the pause. Circular wait: the base copy wedges
 * `connected:true`, silent, frozen at version 0, with no self-heal.
 *
 * (This is distinct from the copy-mode `onCommit` blob-await deadlock, which the async durable watermark
 * already fixed; that fix lets the copy run far enough to expose THIS one.)
 *
 * Real FILE-BACKED blobs are required (size > FILE_STORAGE_THRESHOLD = 8192) so the receive save goes
 * through the streamed BLOB_CHUNK path — a base64 string in a Bytes column never externalizes. We mint them
 * with the same caching (`sourcedFrom`) fixture the non-copy blobGapDeadlock test uses, but seed them on the
 * SOURCE before the subscription so add_node base-copies them. `recordConcurrency` is lowered on the
 * RECEIVER so its apply falls behind and a blob's chunks reliably outrun its record.
 *
 * Expected: FAILS (wedges, B frozen short of RECORDS) on code that pauses for a consumer-less stream;
 * PASSES once the receive loop skips the backpressure pause until the stream has a consumer.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { cp, mkdtemp } from 'node:fs/promises';
import { sendOperation, fetchWithRetry } from './clusterShared.mjs';

// setupHarperWithFixture() overwrites ctx.harper (dropping the hostname), which desyncs the configured
// replication securePort host from the actual NODE_HOSTNAME. We install the fixture the same way but
// PRESERVE the pre-assigned hostname so the source's listener and the subscriber's dial target match.
async function startWithFixture(nodeCtx, fixturePath, options) {
	const dataRootDir = await mkdtemp(
		join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
	);
	await cp(fixturePath, join(dataRootDir, 'components', basename(fixturePath)), { recursive: true, dereference: true });
	nodeCtx.harper = { hostname: nodeCtx.harper.hostname, dataRootDir };
	return startHarper(nodeCtx, options);
}

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const RECORDS = 80; // file-backed blobs seeded on the source, base-copied to the subscriber
const BLOB_CHUNKS = process.env.HARPER_TEST_BLOB_CHUNKS || '128'; // 128 * 4096 = 512 KB/blob -> many BLOB_CHUNK frames
const CONVERGE_TIMEOUT_MS = 60000;
const POLL_MS = 500;
const FIXTURE = join(import.meta.dirname ?? module.path, 'fixture-blob-gap-deadlock-source');

function sharedConfig(host, extra = {}) {
	return {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, console: true, level: 'debug' },
		replication: { securePort: host + ':9933', ...extra },
	};
}

suite('Copy-mode blob deadlock (base copy)', { timeout: 240000 }, (ctx) => {
	before(async () => {
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		// A: source/sender. Normal concurrency; mints the file-backed blobs.
		await startWithFixture(nodeA, FIXTURE, {
			config: sharedConfig(nodeA.harper.hostname),
			env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_BLOB_CHUNKS: BLOB_CHUNKS },
		});
		// B: receiver. Low recordConcurrency throttles B's apply so it falls behind during the base copy,
		// letting a blob's chunks reliably outrun its record — the consumer-less condition the deadlock needs.
		await startWithFixture(nodeB, FIXTURE, {
			config: sharedConfig(nodeB.harper.hostname, { recordConcurrency: 3 }),
			env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_BLOB_CHUNKS: BLOB_CHUNKS },
		});
		ctx.nodes = [nodeA.harper, nodeB.harper];

		// Seed RECORDS file-backed blobs on A BEFORE B subscribes, so add_node base-copies them.
		for (let id = 1; id <= RECORDS; id++) {
			await fetchWithRetry(ctx.nodes[0].httpURL + '/Prerender/' + id);
		}
		const aDesc = await sendOperation(ctx.nodes[0], { operation: 'describe_table', table: 'Prerender' });
		ok((aDesc.record_count ?? 0) >= RECORDS, `source did not materialize blobs: holds ${aDesc.record_count}/${RECORDS}`);
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n })));
	});

	test('a file-backed base copy must not wedge connected:true at version 0', async () => {
		// B subscribes to A -> base copy of Prerender streams A's file-backed blobs (COPY MODE).
		const tokenResp = await sendOperation(ctx.nodes[0], {
			operation: 'create_authentication_tokens',
			authorization: ctx.nodes[0].admin,
		});
		// The replication listener can take a moment to accept after startup; retry add_node through
		// transient ECONNREFUSED, then poll until the data socket reports connected.
		for (let i = 0; i < 15; i++) {
			const r = await sendOperation(ctx.nodes[1], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				authorization: 'Bearer ' + tokenResp.operation_token,
			}).catch((e) => ({ error: String(e) }));
			if (!r?.error) break;
			await delay(500 * (i + 1));
		}
		let connected = false;
		for (let i = 0; i < 30 && !connected; i++) {
			const status = await sendOperation(ctx.nodes[1], { operation: 'cluster_status' }).catch(() => null);
			connected = (status?.connections ?? []).some((c) => (c.database_sockets ?? []).some((s) => s.connected));
			if (!connected) await delay(500);
		}
		ok(connected, 'B never connected to A — setup/plumbing failure, not a deadlock');

		// describe_table.record_count is the authoritative convergence signal (a direct GET on B could be
		// served by B's own caching source). On wedged code it stalls well short of RECORDS.
		const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
		let last = -1;
		let converged = false;
		while (Date.now() < deadline) {
			const d = await sendOperation(ctx.nodes[1], { operation: 'describe_table', table: 'Prerender' }).catch(() => null);
			const c = d?.record_count ?? -1;
			if (c !== last) last = c;
			if (c >= RECORDS) {
				converged = true;
				break;
			}
			await delay(POLL_MS);
		}
		ok(
			converged,
			`base copy wedged: subscriber holds ${last}/${RECORDS} records (a blob's chunks outran its record; the consumer-less blob-backpressure pause stranded the receive loop)`
		);
	});
});
