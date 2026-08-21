/**
 * Mid-log transaction-log tear: replication resyncs past it instead of starving behind it.
 *
 * End-to-end coverage for HarperFast/harper#2016 (mid-log tear silently truncates replay and
 * replication) and HarperFast/harper#2063 (the containment was per-drain, so the stall was
 * permanent). The unit tests on both fix PRs drive synthetic iterators and hand-built buffers;
 * this is the only place a genuinely damaged log on disk is read by a real replication stream.
 *
 * Why a tear is recoverable at all: a partial `ENOSPC`/`EDQUOT` append that the process survives
 * leaves intact, already-acknowledged entries after the broken frame. Treating the break as
 * end-of-log amputates them, and permanently -- every later drain restarts from the same resume
 * cursor and stops at the same frame. In the field incident behind #2063 that ran 11 days with
 * `cluster_status` reporting `connected: true` throughout.
 *
 * Shape:
 *   - A and B join via add_node. BATCH_ONE rows are written to A and B converges, establishing
 *     a resume cursor.
 *   - B is taken offline. BATCH_TWO rows are written to A -- acknowledged to the client, and
 *     living in A's `local` transaction log where B has not read them yet.
 *   - A is stopped and a frame near the END of its log is torn: the frame's declared length is
 *     rewritten to one the file cannot satisfy, so the reader must find where framing resumes.
 *     The tear sits well past B's cursor, so every entry behind it is one B still owes its client.
 *   - Both nodes come back. B resumes from its pre-tear cursor and must read *through* the break.
 *
 * The oracle is the LAST row written, not just a count: under the defect B stalls at the tear and
 * the tail never arrives. The complete set is asserted too, since every row was acknowledged and
 * resyncing must preserve all of them, including the row in the torn frame.
 *
 * What this does NOT cover: the crash-recovery replay arm of #2016 (single-node, core's
 * `replayLogs.ts`); the write side -- nothing here stops a tear being created, which is
 * HarperFast/rocksdb-js#748; and the *readable* tear shape, where the torn frame is still
 * yielded and its undecodable payload wedges the receiver instead (#669). Measured against this
 * same harness, the readable shape leaves B at 39/60 rows even on a fixed engine.
 *
 * Requires an engine that exports `CorruptFrameError`; skipped otherwise (see ENGINE_RESYNCS).
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	killHarper,
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { sendOperation, stopNodeProcess } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

// Kept in step with TRANSACTION_LOG_FILE_HEADER_SIZE / TRANSACTION_LOG_ENTRY_HEADER_SIZE in
// rocksdb-js `src/binding/transaction_log/transaction_log_file.h`. An entry header is a
// big-endian float64 timestamp, a uint32 payload length, and a flag byte.
const FILE_HEADER_SIZE = 13;
const ENTRY_HEADER_SIZE = 13;
const LOG_FILE_MAGIC = 'WOOF';

const DATABASE = 'data';
const TABLE = 'torn';
const BATCH_ONE = 10;
const BATCH_TWO = 50;
const TOTAL = BATCH_ONE + BATCH_TWO;

// Frames left intact after the tear. rocksdb-js needs a run of 8 well-formed frames to call the
// break mid-log rather than a torn tail, so the tear must sit far enough from the end to clear
// that -- and every frame after it is a row B must still receive.
const FRAMES_AFTER_TEAR = 20;

const CONVERGE_TIMEOUT_MS = 90_000;

// `CorruptFrameError` is the marker for an engine that reports where framing resumes; without it
// every break still reads as end-of-log and this test would be asserting a fix that isn't there.
// The override exists for the fails-on-base check, where failing is the expected result.
const ENGINE_RESYNCS = await import('@harperfast/rocksdb-js')
	.then((engine) => typeof engine.CorruptFrameError === 'function')
	.catch(() => false);
const FORCED = process.env.HARPER_TXNLOG_TEAR_FORCE === '1';

function nodeStartOptions(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true },
			replication: { securePort: hostname + ':9933', databases: [DATABASE] },
		},
	};
}

/** Walks the entry chain, stopping at the zero-timestamp end-of-entries marker. */
function readFrames(buffer) {
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const frames = [];
	let position = FILE_HEADER_SIZE;
	while (position + ENTRY_HEADER_SIZE <= buffer.length) {
		if (view.getFloat64(position) === 0) break;
		const length = view.getUint32(position + 8);
		if (length === 0 || position + ENTRY_HEADER_SIZE + length > buffer.length) break;
		frames.push({ position, length });
		position += ENTRY_HEADER_SIZE + length;
	}
	return frames;
}

/**
 * Breaks one frame by declaring a length the file cannot satisfy, so the reader cannot read the
 * frame at all and must find where framing resumes.
 *
 * This is the *unreadable* tear shape. The other shape a partial append can leave -- a declared
 * length that overruns into the following frame but still fits the file -- is readable, so the
 * reader yields it as an entry whose payload is the torn bytes plus its neighbour's. Framing
 * recovery cannot help there: the entry looks well-formed and only the consumer can tell it is
 * garbage, and the receiver currently wedges on it (#669). This test deliberately covers the
 * shape the fix is responsible for.
 */
function tearFrame(logPath, framesFromEnd) {
	const buffer = readFileSync(logPath);
	ok(buffer.subarray(0, 4).toString() === LOG_FILE_MAGIC, `${logPath} is not a transaction log`);
	const frames = readFrames(buffer);
	ok(
		frames.length > BATCH_ONE + framesFromEnd + 2,
		`log has only ${frames.length} frames; need more than ${BATCH_ONE + framesFromEnd + 2} ` +
			"to tear one past B's resume cursor"
	);
	const target = frames[frames.length - 1 - framesFromEnd];
	new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setUint32(target.position + 8, buffer.length);
	writeFileSync(logPath, buffer);
	return { ...target, totalFrames: frames.length };
}

function localLogPath(dataRootDir) {
	return join(dataRootDir, 'database', DATABASE, 'transaction_logs', 'local', '1.txnlog');
}

async function rowIds(node) {
	const rows = await sendOperation(node, {
		operation: 'search_by_value',
		database: DATABASE,
		table: TABLE,
		search_attribute: 'id',
		search_value: '*',
		get_attributes: ['id'],
	}).catch(() => []);
	return new Set((Array.isArray(rows) ? rows : []).map((row) => row.id));
}

async function waitForRows(node, target, timeoutMs = CONVERGE_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	let ids = new Set();
	while (Date.now() < deadline) {
		ids = await rowIds(node);
		if (ids.size >= target) return ids;
		await delay(1000);
	}
	return ids;
}

async function insertRows(node, from, count) {
	await sendOperation(node, {
		operation: 'insert',
		database: DATABASE,
		table: TABLE,
		records: Array.from({ length: count }, (_, i) => ({ id: `r${from + i}`, payload: 'x'.repeat(64) })),
	});
}

suite(
	'Mid-log txnlog tear: replication resyncs past it',
	{ skip: !ENGINE_RESYNCS && !FORCED, timeout: 300_000 },
	(ctx) => {
		before(async () => {
			const startNode = async () => {
				const hostname = await getNextAvailableLoopbackAddress();
				const nodeCtx = { name: ctx.name, harper: { hostname } };
				await startHarper(nodeCtx, nodeStartOptions(hostname));
				return nodeCtx.harper;
			};
			ctx.nodeA = await startNode();
			ctx.nodeB = await startNode();

			for (const node of [ctx.nodeA, ctx.nodeB]) {
				await sendOperation(node, {
					operation: 'create_table',
					database: DATABASE,
					table: TABLE,
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'payload', type: 'String' },
					],
				});
			}

			await sendOperation(ctx.nodeB, {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodeA.hostname,
				authorization: ctx.nodeB.admin,
			});
		});

		after(async () => {
			for (const node of [ctx.nodeA, ctx.nodeB]) {
				if (!node) continue;
				try {
					await stopNodeProcess(node);
				} catch {}
				try {
					await teardownHarper({ harper: node });
				} catch {}
			}
		});

		test("B receives the entries written after a torn frame in A's local log", async () => {
			// 1. Establish B's resume cursor on a healthy stream.
			await insertRows(ctx.nodeA, 0, BATCH_ONE);
			const converged = await waitForRows(ctx.nodeB, BATCH_ONE);
			ok(converged.size === BATCH_ONE, `B should hold the first ${BATCH_ONE} rows, got ${converged.size}`);

			// 2. B offline. Everything below is written past its cursor.
			const bHostname = ctx.nodeB.hostname;
			const bDataRootDir = ctx.nodeB.dataRootDir;
			await killHarper({ harper: ctx.nodeB });

			await insertRows(ctx.nodeA, BATCH_ONE, BATCH_TWO);
			const onA = await rowIds(ctx.nodeA);
			ok(onA.size === TOTAL, `A should hold all ${TOTAL} rows before the tear, got ${onA.size}`);

			// 3. Tear a frame near the end of A's log, with A down so the file is quiescent.
			const aHostname = ctx.nodeA.hostname;
			const aDataRootDir = ctx.nodeA.dataRootDir;
			await stopNodeProcess(ctx.nodeA);
			const tear = tearFrame(localLogPath(aDataRootDir), FRAMES_AFTER_TEAR);
			console.log(
				`tore frame @${tear.position} (len ${tear.length}) of ${tear.totalFrames}; ${FRAMES_AFTER_TEAR} frames follow it`
			);

			// 4. Both back up. B resumes from its pre-tear cursor and must read through the break.
			const restartedA = { name: ctx.name, harper: { dataRootDir: aDataRootDir, hostname: aHostname } };
			await startHarper(restartedA, nodeStartOptions(aHostname));
			ctx.nodeA = restartedA.harper;

			const restartedB = { name: ctx.name, harper: { dataRootDir: bDataRootDir, hostname: bHostname } };
			await startHarper(restartedB, nodeStartOptions(bHostname));
			ctx.nodeB = restartedB.harper;

			const finalIds = await waitForRows(ctx.nodeB, TOTAL);

			// The tail is the oracle: a stream that stopped at the tear never delivers the last row,
			// however many rows it managed before it.
			ok(
				finalIds.has(`r${TOTAL - 1}`),
				`B is missing the last row written after the tear (r${TOTAL - 1}); it holds ${finalIds.size}/${TOTAL} rows, ` +
					'which is what a stream that stopped at the torn frame looks like'
			);

			// Every row was acknowledged, including the row whose frame is torn.
			const missing = Array.from({ length: TOTAL }, (_, i) => `r${i}`).filter((id) => !finalIds.has(id));
			ok(
				missing.length === 0,
				`resync should preserve every acknowledged row, but B is missing ${missing.length}: ${missing.join(', ')}`
			);
		});
	}
);
