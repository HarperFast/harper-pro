/**
 * Regression guard for the cross-reconnect blob-gap escalation budget (harper-pro#432).
 *
 * Mechanism (replication/replicationConnection.ts):
 *   - The SOURCE holds a blob whose file reads back as core's PENDING placeholder forever (the fixture
 *     stamps its header; in the field an idle-watchdog stub did the same). Every `sendBlobs` read of it
 *     rejects `BlobReadError(…, 503)`; the sender retries in place (BLOB_SEND_RETRY_DELAYS_MS), then
 *     forwards a BLOB_CHUNK `error` marker with `errorStatus: 503`.
 *   - The receiver classifies 503 as TRANSIENT: the save `.catch` latches `hasBlobGap`, pins the durable
 *     resume cursor, and arms the #683 blob-gap reconnect timer. The reconnect re-streams the same
 *     record, the source answers 503 again, and — BEFORE this fix — every per-socket counter restarted
 *     with the socket, so the cursor stayed pinned for as long as the source kept answering 503.
 *   - WITH the fix, the connection's `blobGapBudget` charges one cycle per socket generation for that
 *     delivery; on the `blobGapEscalationCycles`-th cycle it is reclassified as unrecoverable and the
 *     existing advance-past branch skips it (loud error, slot-7 metric, file unlinked = repair signal).
 *
 * Oracles: (1) B's escalation error line — absent on unfixed code, which loops "Blob-gap watchdog"
 * fires for the whole window; (2) the watchdog stops firing once the only bad delivery is escalated;
 * (3) later records replicate; (4) after `restartNode(B)` the source does NOT resend the bad delivery
 * while a later record still replicates — the persisted cursor is past it; (5) repairability: B's read
 * of the skipped record's blob classifies as unavailable (core's PENDING/gone taxonomy, never served as
 * bytes), and once the source is healed `repair_blob_data` on B selects that record. The sweep's fetch
 * itself cannot be asserted here: the operation runs on the main thread, which owns no subscription
 * connections (`noConnection` in its summary — a pre-existing #388 limitation), so the exact-bytes
 * check is made only when the sweep reports a repair.
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	sendOperation,
	fetchWithRetry,
	readLog,
	restartNode,
	stopNodeProcess,
	waitForCondition,
} from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const SEED_RECORDS = 6; // /SeedAuthLocation/{n} on A — each a deterministic 50 KB file-backed blob
const GAP_RECONNECT_MS = 2000; // #683 watchdog cycle, shortened from the 900s default
const ESCALATION_CYCLES = 3; // replication.blobGapEscalationCycles under test
const CHUNK = 1024;
const CHUNKS = 50;
const BLOB_SIZE = CHUNK * CHUNKS;

// Mirrors blobForId in fixture-large-blob-authoritative/resources.js so the repaired bytes on B can be
// compared exactly.
function expectedBytesForId(id) {
	const seed = Number(id) | 0;
	const out = Buffer.allocUnsafe(BLOB_SIZE);
	for (let c = 0; c < CHUNKS; c++) {
		for (let i = 0; i < CHUNK; i++) out[c * CHUNK + i] = (seed * 131 + c * 31 + i) & 0xff;
	}
	return out;
}

// add_node's CSR exchange connects straight to the replication port with no retry; wait for it to bind.
async function waitForPort(host, port, timeoutMs = 30000) {
	return waitForCondition(
		() =>
			new Promise((resolve) => {
				const socket = netConnect({ host, port }, () => {
					socket.destroy();
					resolve(true);
				});
				socket.on('error', () => resolve(false));
				socket.setTimeout(1000, () => {
					socket.destroy();
					resolve(false);
				});
			}),
		{ timeoutMs, pollMs: 250, description: `${host}:${port} to accept connections` }
	);
}

const count = (log, pattern) => (log.match(pattern) ?? []).length;
const WATCHDOG_FIRE = /Blob-gap watchdog/g;
const ESCALATION = /blob-gap escalation budget exhausted/g;
const SOURCE_SEND_ERROR = /Error sending blob/g;

// Start a node with the given fixture components pre-installed, so no deploy/restart is needed and the
// fixture's process env is exactly what we pass here.
async function startWithComponents(ctx, name, hostname, fixtures, options) {
	const dataRootDir = await mkdtemp(
		join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
	);
	for (const fixture of fixtures) {
		await cp(join(import.meta.dirname, fixture), join(dataRootDir, 'components', fixture), {
			recursive: true,
			dereference: true,
		});
	}
	const node = { name, harper: { dataRootDir, hostname } };
	await startHarper(node, options);
	return node.harper;
}

const sharedConfig = (host) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false, console: true, level: 'warn' },
	replication: { securePort: host + ':9933' },
});

const describeTable = (node, signal) =>
	sendOperation(node, { operation: 'describe_table', table: 'AuthLocation' }, { signal })
		.then((r) => r.record_count ?? 0)
		.catch(() => 0);

suite('Blob-gap escalation budget bounds a 503-forever source (#432)', { timeout: 600000 }, (ctx) => {
	before(async () => {
		ctx.healFile = join(await mkdtemp(join(tmpdir(), 'blob-gap-escalation-')), 'heal');
		const hostA = await getNextAvailableLoopbackAddress();
		const hostB = await getNextAvailableLoopbackAddress();
		// A is the SOURCE: the pending-source injector stamps exactly ONE blob (the first seeded) so there is
		// exactly one failing delivery, and the authoritative blob table provides the seed + byte-reader.
		const A = await startWithComponents(
			ctx,
			ctx.name,
			hostA,
			['fixture-blob-pending-source', 'fixture-large-blob-authoritative'],
			{
				config: sharedConfig(hostA),
				env: {
					HARPER_NO_FLUSH_ON_EXIT: true,
					HARPER_TEST_BLOB_PENDING_MODULUS: '1',
					HARPER_TEST_BLOB_PENDING_COUNT: '1',
					HARPER_TEST_BLOB_PENDING_HEAL_FILE: ctx.healFile,
				},
			}
		);
		// B is the RECEIVER under test: short gap cycles and a 3-cycle budget so escalation lands in seconds.
		const B = await startWithComponents(ctx, ctx.name, hostB, ['fixture-large-blob-authoritative'], {
			config: {
				...sharedConfig(hostB),
				replication: {
					securePort: hostB + ':9933',
					blobGapReconnectMs: GAP_RECONNECT_MS,
					blobGapEscalationCycles: ESCALATION_CYCLES,
					blobGapEscalationMs: 600000,
				},
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});
		ctx.nodes = [A, B];
		const bootLog = await readLog(A);
		ok(
			bootLog.includes('[blob-pending-source] installed'),
			'pending-source injector did not load on A — the test would not exercise the 503 path'
		);
	});

	after(async () => {
		if (!ctx.nodes) return;
		if (ctx.restartedB) await stopNodeProcess(ctx.nodes[1]).catch(() => null);
		await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n }).catch(() => null)));
	});

	test('a delivery the source keeps failing with 503 is skipped after the budget, and stays repairable', async () => {
		const [A, B] = ctx.nodes;

		// Seed A before B joins, sequentially, so the stamped (first) blob is fully written and PENDING before
		// anything reads it: the base copy to B then meets exactly one 503-forever delivery.
		for (let id = 0; id < SEED_RECORDS; id++) {
			const response = await fetchWithRetry(A.httpURL + '/SeedAuthLocation/' + id);
			ok(response.ok, `seeding record ${id} failed: HTTP ${response.status}`);
		}
		await waitForCondition((signal) => describeTable(A, signal).then((n) => n >= SEED_RECORDS), {
			timeoutMs: 30000,
			description: `A to hold ${SEED_RECORDS} seeded records`,
		});
		const stampedLog = await waitForCondition(
			async () => {
				const log = await readLog(A);
				return log.includes('[blob-pending-source] stamped ') ? log : false;
			},
			{ timeoutMs: 30000, description: 'the pending-source injector to stamp a blob on A' }
		);
		equal(count(stampedLog, /\[blob-pending-source\] stamped /g), 1, 'expected exactly one stamped source blob');

		ok(await waitForPort(A.hostname, 9933), `A never listened on ${A.hostname}:9933`);
		const tokenResp = await sendOperation(A, { operation: 'create_authentication_tokens', authorization: A.admin });
		await sendOperation(B, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: A.hostname,
			authorization: 'Bearer ' + tokenResp.operation_token,
		});

		// Oracle 1: the budget trips on the configured cycle and the escalation line names the delivery.
		const escalation = await waitForCondition(
			async () => {
				const log = await readLog(B);
				return (
					log.match(
						/Blob (\S+) for record (\S+) stayed transiently unavailable at source .*blob-gap escalation budget exhausted after (\d+) reconnect cycle/
					) ?? false
				);
			},
			{
				timeoutMs: 150000,
				description: () => 'B to escalate the held delivery (unfixed code holds the cursor forever)',
			}
		);
		const [, blobId, recordId, cyclesText] = escalation;
		equal(Number(cyclesText), ESCALATION_CYCLES, `escalated after ${cyclesText} cycles, expected ${ESCALATION_CYCLES}`);
		let bLog = await readLog(B);
		const firesAtEscalation = count(bLog, WATCHDOG_FIRE);
		ok(
			firesAtEscalation >= ESCALATION_CYCLES - 1,
			`expected at least ${ESCALATION_CYCLES - 1} blob-gap watchdog reconnects before escalation, saw ${firesAtEscalation}`
		);
		ok(bLog.includes('Blob pending replication'), 'the escalated failure should be the source 503 (PENDING) class');
		console.log(
			`[#432] escalated blob ${blobId} of record ${recordId} after ${cyclesText} cycles; watchdog fires so far ${firesAtEscalation}`
		);

		// Oracle 2 + 3: the copy completes past the skipped delivery, and the watchdog goes quiet.
		await waitForCondition((signal) => describeTable(B, signal).then((n) => n >= SEED_RECORDS), {
			timeoutMs: 60000,
			description: `B to receive all ${SEED_RECORDS} seeded records`,
		});
		await delay(GAP_RECONNECT_MS * 4);
		bLog = await readLog(B);
		equal(
			count(bLog, WATCHDOG_FIRE),
			firesAtEscalation,
			'the blob-gap watchdog kept firing after the only bad delivery was escalated — the cursor is still pinned'
		);
		equal(count(bLog, ESCALATION), 1, 'the single bad delivery escalated more than once');
		const status = await sendOperation(B, { operation: 'cluster_status' });
		const socket = status.connections.flatMap((c) => c.database_sockets ?? []).find((s) => s.database === 'data');
		ok(
			(socket?.blobReplicationFailures ?? 0) >= 1,
			`cluster_status.blobReplicationFailures should count the skip: ${JSON.stringify(socket)}`
		);

		// A later record replicates live past the skipped one.
		ok((await fetchWithRetry(A.httpURL + '/SeedAuthLocation/100')).ok, 'seeding the marker record failed');
		await waitForCondition((signal) => describeTable(B, signal).then((n) => n >= SEED_RECORDS + 1), {
			timeoutMs: 60000,
			description: 'the marker record to replicate to B after the skip',
		});

		// Oracle 4: the persisted cursor is past the bad delivery. After a restart B resumes from disk; if the
		// cursor were still pinned, A would re-stream the bad record (a fresh "Error sending blob" on A and a
		// fresh hold/escalation on B) before or alongside the second marker.
		const sourceSendErrorsBefore = count(await readLog(A), SOURCE_SEND_ERROR);
		await restartNode(B);
		ctx.restartedB = true;
		await waitForCondition(
			async (signal) => {
				const s = await sendOperation(B, { operation: 'cluster_status' }, { signal }).catch(() => null);
				return !!s?.connections?.some((c) => (c.database_sockets ?? []).some((x) => x.connected));
			},
			{ timeoutMs: 60000, description: 'B to reconnect to A after its restart' }
		);
		ok((await fetchWithRetry(A.httpURL + '/SeedAuthLocation/101')).ok, 'seeding the post-restart marker failed');
		await waitForCondition((signal) => describeTable(B, signal).then((n) => n >= SEED_RECORDS + 2), {
			timeoutMs: 60000,
			description: 'the post-restart marker record to replicate to B',
		});
		await delay(GAP_RECONNECT_MS * 4);
		bLog = await readLog(B);
		equal(
			count(await readLog(A), SOURCE_SEND_ERROR),
			sourceSendErrorsBefore,
			'A re-sent the bad delivery after B restarted — the persisted resume cursor had not advanced past it'
		);
		equal(
			count(bLog, ESCALATION),
			1,
			'B held/escalated the bad delivery again after restart — the cursor was not durable'
		);
		equal(count(bLog, WATCHDOG_FIRE), firesAtEscalation, 'B re-held the cursor after restart');

		// Oracle 5: the skipped record is repairable. Heal the source, then run the repair sweep on B.
		await writeFile(ctx.healFile, '');
		await waitForCondition(async () => (await readLog(A)).includes('[blob-pending-source] healed 1 file(s)'), {
			timeoutMs: 15000,
			description: 'the source to heal its stamped blob',
		});
		await sendOperation(B, { operation: 'repair_blob_data', database: 'data' });
		const summary = await waitForCondition(
			async () => {
				const m = (await readLog(B)).match(
					/Blob repair complete for data.*?checked[^\d]*(\d+).*?repaired[^\d]*(\d+).*?failed[^\d]*(\d+)/s
				);
				return m ? { checked: Number(m[1]), repaired: Number(m[2]), failed: Number(m[3]) } : false;
			},
			{ timeoutMs: 60000, description: 'the blob repair sweep on B to complete' }
		);
		console.log(`[#432] repair sweep on B: ${JSON.stringify(summary)}`);
		ok(summary.checked >= 1, `the repair sweep did not select the skipped record: ${JSON.stringify(summary)}`);
		// An authoritative table cannot re-source, so this read is served from B's own blob file: the aborted
		// save left a PENDING stub (unlinked later by the retention sweep), which core refuses to serve.
		const blobResp = await fetchWithRetry(B.httpURL + '/AuthLocationImage/' + recordId, { retries: 2 }).catch(
			(error) => ({ ok: false, status: `fetch failed: ${error?.cause?.message ?? error?.message}` })
		);
		const bytes = blobResp.ok ? Buffer.from(await blobResp.arrayBuffer()) : Buffer.alloc(0);
		const intact = bytes.length === BLOB_SIZE && bytes.equals(expectedBytesForId(recordId));
		const bBlobDir = join(B.dataRootDir, 'blobs', 'data').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const classifiedUnavailable = new RegExp(
			`BlobReadError: (Blob pending replication|Blob file not found) for ${bBlobDir}`
		).test(await readLog(B));
		console.log(
			`[#432] record ${recordId} blob on B after the sweep: HTTP ${blobResp.status}, ${bytes.length} bytes, intact=${intact}, classifiedUnavailable=${classifiedUnavailable}`
		);
		if (summary.repaired >= 1) {
			ok(intact, `the sweep reported a repair but B does not serve the exact bytes for record ${recordId}`);
		} else {
			ok(
				!intact && classifiedUnavailable,
				`the skipped record's blob must classify as unavailable on B until repaired (intact=${intact}, classifiedUnavailable=${classifiedUnavailable})`
			);
		}
	});
});
