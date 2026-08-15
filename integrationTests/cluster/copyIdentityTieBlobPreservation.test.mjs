/**
 * A base (full-table) copy must not destroy blob content the receiving node already holds.
 *
 * Copy frames are applied as snapshots with no CRDT resequencing and no duplicate detection, so every
 * copied record is re-written locally and its file-backed blobs are re-minted as fresh local files,
 * dereferencing the ones already on disk. That is correct when the copy is populating a node, but a
 * subscription with no resume cursor ALWAYS requests a full copy — including the reverse leg of a
 * bidirectional join, which lands after the peer has already received this node's data. The node then
 * copies its own records back from the peer and trades durable local blob bytes for a re-transfer of
 * identical content. Interrupt that mid-blob and the record is left pointing at a PENDING stub the peer
 * can never fill, because it never held the bytes either — the blob is lost on BOTH nodes. That is the
 * failure the QA-692 stress test (blobCopyInterruptionIntegrity.test.mjs) hits intermittently, where the
 * SOURCE node ends up serving 503 for a handful of blobs it wrote itself and never lost.
 *
 * This pins the invariant that removes the loss window: a copy frame that is a provable identity tie with
 * a locally stored record (same version, same origin node) whose blob files are all present must not
 * re-mint anything.
 *
 * Deterministic (no kills, no timing race):
 *   1. A seeds N blob records — every blob file on A is A's own, complete.
 *   2. B joins subscribing ONLY from A (`publish: false` on B's side, so A does not subscribe back yet)
 *      and converges on all N records.
 *   3. B originates one further record, so the reverse copy has something real to deliver.
 *   4. A then subscribes to B. With no resume cursor for B this is a full copy — of A's own N records
 *      plus B's one — and it is the copy under test.
 *
 * Oracle (both, so neither deletion timing nor id reuse can hide a re-mint):
 *   - every blob file A held before the reverse copy still exists, and
 *   - A's blob-store file count grew by exactly the one genuinely new (B-originated) record.
 * Plus: every blob on A still reads back byte-exact, and the "Requesting full copy" line proves the copy
 * under test actually ran.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal, deepEqual } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { fetchWithRetry, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const RECORD_COUNT = 8;
const B_ORIGINATED_ID = RECORD_COUNT; // the one record the reverse copy must genuinely deliver
const CONVERGENCE_TIMEOUT_MS = 90000;
const COPY_SETTLE_MS = 15000;
const READY_CONSECUTIVE_PROBES = 8;
const OP_TIMEOUT_MS = 20000;
// Shared with blobCopyInterruptionIntegrity.test.mjs: an authoritative (no sourcedFrom) blob table whose
// ~1 MiB payload is a pure function of the record id.
const FIXTURE_PATH = join(import.meta.dirname, 'fixture-qa692-blob-authoritative');
const PROJECT = 'qa692-blob-authoritative';

// Must match fixture-qa692-blob-authoritative/resources.js blobForId exactly.
const CHUNK = 1024;
const CHUNKS = 1024;
const BLOB_SIZE = CHUNK * CHUNKS;
function expectedBytesForId(id) {
	const seed = Number(id) | 0;
	const out = Buffer.allocUnsafe(BLOB_SIZE);
	for (let c = 0; c < CHUNKS; c++) {
		for (let i = 0; i < CHUNK; i++) out[c * CHUNK + i] = (seed * 131 + c * 31 + i) & 0xff;
	}
	return out;
}

function blobStoreFiles(dataRootDir, db = 'data') {
	const root = join(dataRootDir, 'blobs', db);
	if (!existsSync(root)) return [];
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.push(path);
		}
	};
	walk(root);
	return files.sort();
}

const sharedConfig = (host) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false, stdStreams: false, console: true, level: 'trace' },
	replication: { securePort: host + ':9933', databases: ['data'] },
});

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

async function recordCount(node) {
	try {
		const desc = await op(node, { operation: 'describe_table', database: 'data', table: 'BlobCopyRecord' });
		return desc?.record_count ?? 0;
	} catch {
		return -1;
	}
}

/**
 * Wait for the fixture's table to be describable, and require several consecutive successes a second
 * apart: a deploy restart tears the listener down asynchronously, so a single success can still be the
 * outgoing process answering. Consecutive successes across the restart window prove the new one is up
 * without guessing how long the restart takes.
 */
async function waitForReady(node) {
	const deadline = Date.now() + CONVERGENCE_TIMEOUT_MS;
	let consecutive = 0;
	let lastError;
	while (Date.now() < deadline) {
		try {
			await op(node, { operation: 'describe_table', database: 'data', table: 'BlobCopyRecord' });
			if (++consecutive >= READY_CONSECUTIVE_PROBES) return;
		} catch (error) {
			lastError = error;
			consecutive = 0;
		}
		await delay(1000);
	}
	throw new Error(`${node.hostname} never served the fixture table: ${lastError?.message ?? lastError}`);
}

async function deployFixture(node) {
	const payload = await targz(FIXTURE_PATH);
	const response = await op(node, { operation: 'deploy_component', project: PROJECT, payload, restart: true }, 30000);
	equal(response.message, `Successfully deployed: ${PROJECT}, restarting Harper`);
	await waitForReady(node);
}

/** Write one record via the fixture's seed endpoint, retrying until it is genuinely accepted. */
async function seedRecord(node, id) {
	const deadline = Date.now() + CONVERGENCE_TIMEOUT_MS;
	let lastStatus;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(node.httpURL + '/SeedBlobCopyRecord/' + id, {
				signal: AbortSignal.timeout(OP_TIMEOUT_MS),
			});
			lastStatus = response.status;
			await response.arrayBuffer(); // drain so the connection is reusable
			if (response.status === 200) return;
		} catch (error) {
			lastStatus = (error && error.message) || String(error);
		}
		await delay(500);
	}
	throw new Error(`seeding record ${id} on ${node.hostname} never succeeded (last: ${lastStatus})`);
}

async function readBlob(node, id) {
	const response = await fetchWithRetry(node.httpURL + '/BlobCopyImage/' + id, { retries: 20 });
	ok(response.status === 200, `GET /BlobCopyImage/${id} on ${node.hostname} returned ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

async function verifyAllBlobs(node, ids) {
	const failures = [];
	for (const id of ids) {
		try {
			const bytes = await readBlob(node, id);
			if (!bytes.equals(expectedBytesForId(id))) failures.push(`id=${id}:bytes-mismatch(length=${bytes.length})`);
		} catch (error) {
			failures.push(`id=${id}:${(error && error.message) || error}`);
		}
	}
	return failures;
}

async function waitForCount(node, target) {
	const deadline = Date.now() + CONVERGENCE_TIMEOUT_MS;
	let count = -1;
	while (Date.now() < deadline) {
		count = await recordCount(node);
		if (count >= target) return count;
		await delay(250);
	}
	return count;
}

suite('base copy of records the receiver already holds preserves its blob files', { timeout: 300000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const source = { name: ctx.name, harper: { hostname: hostnameA } };
		await startHarper(source, { config: sharedConfig(hostnameA) });
		ctx.source = source.harper;
		await deployFixture(ctx.source);

		for (let id = 0; id < RECORD_COUNT; id++) await seedRecord(ctx.source, id);
		equal(await recordCount(ctx.source), RECORD_COUNT, `A should have seeded ${RECORD_COUNT} rows`);
	});

	after(async () => {
		await Promise.all(
			[ctx.source && teardownHarper({ harper: ctx.source }), ctx.peer && teardownHarper({ harper: ctx.peer })].filter(
				Boolean
			)
		);
	});

	test('a reverse full copy does not re-mint blob files for records the node originated', async () => {
		const hostnameB = await getNextAvailableLoopbackAddress();
		const peerCtx = { name: ctx.name, harper: { hostname: hostnameB } };
		await startHarper(peerCtx, { config: sharedConfig(hostnameB) });
		ctx.peer = peerCtx.harper;
		await deployFixture(ctx.peer);

		// One-directional join, A → B only. `sendsTo` is B-record-relative on both sides after add_node
		// reverses it: B's row for A says A sends to B (so B subscribes), and A's row for B says B receives
		// from A but does not send (so A does NOT subscribe back yet, and cannot copy from B until step 4).
		await op(ctx.peer, {
			operation: 'add_node',
			hostname: ctx.source.hostname,
			rejectUnauthorized: false,
			authorization: ctx.source.admin,
			sendsTo: [{ database: 'data' }],
		});
		equal(
			await waitForCount(ctx.peer, RECORD_COUNT),
			RECORD_COUNT,
			`B should have received all ${RECORD_COUNT} records from A`
		);

		// A record B originates itself, so the reverse copy has something to deliver that A cannot already
		// have — without it a green result could mean "the copy delivered nothing".
		await seedRecord(ctx.peer, B_ORIGINATED_ID);
		equal(await recordCount(ctx.peer), RECORD_COUNT + 1, 'B should hold its own extra record');

		const filesBefore = blobStoreFiles(ctx.source.dataRootDir);
		equal(filesBefore.length, RECORD_COUNT, `A should hold exactly ${RECORD_COUNT} blob files before the copy`);

		// Now open the reverse leg. A has no resume cursor for B, so this is a full copy — of A's own
		// records plus B's new one.
		await op(ctx.source, {
			operation: 'set_node',
			hostname: ctx.peer.hostname,
			rejectUnauthorized: false,
			authorization: ctx.peer.admin,
			sendsTo: [{ database: 'data' }],
			receivesFrom: [{ database: 'data' }],
		});

		equal(
			await waitForCount(ctx.source, RECORD_COUNT + 1),
			RECORD_COUNT + 1,
			"A should have received B's record over the reverse copy"
		);
		await delay(COPY_SETTLE_MS); // let the whole copy (not just the first record) apply and its blobs settle

		const sourceLog = await readLog(ctx.source).catch(() => '');
		ok(
			/Requesting full copy of database data/.test(sourceLog),
			'precondition never armed: A never requested a full copy from B, so no copy frames were applied'
		);
		ok(
			(sourceLog.match(/copy identity-tie skip/g) ?? []).length >= RECORD_COUNT,
			'expected the receiver-side identity-tie gate to skip every A-originated blob record from B\'s copy'
		);

		const filesAfter = blobStoreFiles(ctx.source.dataRootDir);
		const vanished = filesBefore.filter((path) => !existsSync(path));
		const allIds = Array.from({ length: RECORD_COUNT + 1 }, (_, i) => i);
		const contentFailures = await verifyAllBlobs(ctx.source, allIds);

		console.log(
			`[copy-tie] A blob files before=${filesBefore.length} after=${filesAfter.length} vanished=${vanished.length}`
		);

		deepEqual(
			vanished,
			[],
			`DEFECT: the reverse copy dereferenced ${vanished.length} of A's own blob files and re-minted them from B. ` +
				`Interrupt that copy mid-blob and those records are left on a PENDING stub B can never fill: ${vanished.join(', ')}`
		);
		equal(
			filesAfter.length,
			RECORD_COUNT + 1,
			`DEFECT: A's blob store grew from ${filesBefore.length} to ${filesAfter.length}; only the one B-originated ` +
				`record should have added a file, so the copy re-minted blobs for records A already held`
		);
		deepEqual(contentFailures, [], `A must still serve every blob byte-exact after the copy`);
	});
});
