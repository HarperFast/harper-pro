/**
 * Mid-log transaction-log tear: replication stops at the break and reports it.
 *
 * A partial `ENOSPC`/`EDQUOT` append the process survives can leave one unreadable frame in a
 * source's transaction log with intact, already-acknowledged entries behind it. The policy for that
 * shape is fail-stop (harper#2087): the stream delivers everything before the break, stops there
 * rather than skipping the frame -- a frame is not a transaction boundary, so skipping it could
 * apply part of a source transaction -- and reports the break with the offset where framing
 * resumes. Entries behind the break stay quarantined until the log is repaired or the node is
 * re-cloned; nothing here recovers them.
 *
 * One asymmetry the oracle locks in: B ends up with exactly the rows whose frames precede the torn
 * one, and the torn frame sits inside the 50-row source transaction, so that prefix is part of a
 * transaction B never sees the rest of. Streaming replication commits what it drained; #2087's
 * atomic discard of a truncated transaction is the crash-recovery replay arm, not exercised here.
 * Boundary tracking in replication would change this expectation.
 *
 * Not covered: the readable tear shape, where the torn frame is yielded with a garbage payload and
 * wedges the receiver (harper-pro#669); a torn tail; `cluster_status` surfacing the break
 * (harper-pro#667); and the write side that lets a tear happen at all (rocksdb-js#748).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	killHarper,
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { readLog, sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

// Kept in step with TRANSACTION_LOG_FILE_HEADER_SIZE / TRANSACTION_LOG_ENTRY_HEADER_SIZE in
// rocksdb-js `src/binding/transaction_log/transaction_log_file.h`. An entry header is a
// big-endian float64 timestamp, a uint32 payload length, and a flag byte.
const FILE_HEADER_SIZE = 13;
const ENTRY_HEADER_SIZE = 13;
const LOG_FILE_MAGIC = 'WOOF';
const LOG_ID = 1;

const DATABASE = 'data';
const TABLE = 'torn';
const BATCH_ONE = 10;
const BATCH_TWO = 50;
const TOTAL = BATCH_ONE + BATCH_TWO;

// Frames left intact after the tear. rocksdb-js needs a run of 8 well-formed frames to call the
// break mid-log rather than a torn tail, and every one of them is a row B must NOT receive.
const FRAMES_AFTER_TEAR = 20;

const CONVERGE_TIMEOUT_MS = 90_000;
const REPORT_TIMEOUT_MS = 30_000;
// Window in which a write behind the break may (wrongly) reach B before B is read: long enough to
// span a replication reconnect cycle, since a reconnect restarts the drain from B's cursor.
const QUARANTINE_SETTLE_MS = 10_000;

suite('Mid-log txnlog tear: replication stops at the break and reports it', { timeout: 300_000 }, (ctx) => {
	before(async () => {
		const engine = await import('@harperfast/rocksdb-js');
		ok(
			typeof engine.CorruptFrameError === 'function',
			'the engine must report where framing resumes (rocksdb-js >= 2.8.0 exports CorruptFrameError); ' +
				'that diagnostic is part of the contract asserted here, so an older engine is a failure, not a skip'
		);

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
			} catch (error) {
				console.error(`Failed to stop node process for ${node.hostname}:`, error);
			}
			try {
				await teardownHarper({ harper: node });
			} catch (error) {
				console.error(`Failed to tear down Harper for ${node.hostname}:`, error);
			}
		}
	});

	test('B receives every entry before the torn frame, nothing behind it, and A reports the break', async () => {
		await insertRows(ctx.nodeA, 0, BATCH_ONE);
		assertExactRows(await waitForRowCount(ctx.nodeB, BATCH_ONE), rowIds(0, BATCH_ONE), 'before B goes offline');

		const bHostname = ctx.nodeB.hostname;
		const bDataRootDir = ctx.nodeB.dataRootDir;
		await killHarper({ harper: ctx.nodeB });

		// One insert, so the torn frame sits inside a single source transaction.
		await insertRows(ctx.nodeA, BATCH_ONE, BATCH_TWO);
		assertExactRows(await readRows(ctx.nodeA), rowIds(0, TOTAL), 'on A before the tear');

		// A is stopped so the file is quiescent while it is torn. Its pre-stop handle is kept: a restart
		// replays the log before logging.root is repointed, so boot-time lines land in the stopped
		// incarnation's log dir (see replayCatchupSeam.test.mjs).
		const stoppedA = ctx.nodeA;
		await stopNodeProcess(stoppedA);
		const tear = tearFrame(localLogPath(stoppedA.dataRootDir), FRAMES_AFTER_TEAR);
		const beforeBreak = rowIds(0, tear.index);
		console.log(
			`tore frame ${tear.index} (${rowId(tear.index)}) @${tear.position} (len ${tear.length}) of ${tear.totalFrames}; ` +
				`${FRAMES_AFTER_TEAR} frames follow it`
		);

		const restartedA = { name: ctx.name, harper: { dataRootDir: stoppedA.dataRootDir, hostname: stoppedA.hostname } };
		await startHarper(restartedA, nodeStartOptions(stoppedA.hostname));
		ctx.nodeA = restartedA.harper;
		// Only the log is torn; the source table keeps every acknowledged row.
		assertExactRows(await readRows(ctx.nodeA), rowIds(0, TOTAL), 'on A after the restart');

		const restartedB = { name: ctx.name, harper: { dataRootDir: bDataRootDir, hostname: bHostname } };
		await startHarper(restartedB, nodeStartOptions(bHostname));
		ctx.nodeB = restartedB.harper;

		// The sender commits the drained prefix when the drain ends, after it discovered the break, so
		// the prefix must have landed before the diagnostic is read and the negative window opens.
		assertExactRows(
			await waitForRowCount(ctx.nodeB, beforeBreak.length),
			beforeBreak,
			'after B resumed past its cursor'
		);

		const diagnostic = breakDiagnostic(tear);
		const logsOfA = async () => [...new Set([await readLog(stoppedA), await readLog(ctx.nodeA)])].join('\n');
		await waitForCondition(async () => diagnostic.test(await logsOfA()), {
			timeoutMs: REPORT_TIMEOUT_MS,
			description: () => `A's hdb.log to report the break as ${diagnostic}`,
		});

		// A write A acknowledges after the restart is behind the break too, so it must not arrive either.
		await insertRows(ctx.nodeA, TOTAL, 1);
		await delay(QUARANTINE_SETTLE_MS);
		assertExactRows(
			await readRows(ctx.nodeB),
			beforeBreak,
			`${QUARANTINE_SETTLE_MS}ms after A acknowledged a write behind the break`
		);
	});
});

function nodeStartOptions(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true },
			replication: { securePort: hostname + ':9933', databases: [DATABASE] },
		},
	};
}

function rowId(index) {
	return `r${index}`;
}

function rowIds(from, count) {
	return Array.from({ length: count }, (_, i) => rowId(from + i));
}

// Id-specific and delimited, so a row's value proves which row it is and a frame's bytes prove which
// row the frame carries (`r1:` cannot match inside `r10:`).
function payloadFor(id) {
	return `${id}:${'x'.repeat(60)}`;
}

/**
 * The engine's report for this exact tear: the break at the torn frame's offset, and framing
 * resuming at the very next frame. Core logs the error's message whatever level it chooses for the
 * line, so this keys on the two offset clauses and nothing else.
 */
function breakDiagnostic(tear) {
	const resumesAt = tear.position + ENTRY_HEADER_SIZE + tear.length;
	const unreadable = resumesAt - tear.position;
	const clause = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(
		`${clause(`at position ${tear.position.toString(16)} of log ${LOG_ID}`)}[^\\n]*` +
			clause(`valid framing resumes at ${resumesAt.toString(16)}, ${unreadable} byte(s) unreadable`)
	);
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
 * reader yields it as an entry whose payload is the torn bytes plus its neighbour's; only the
 * consumer can tell it is garbage (harper-pro#669).
 *
 * The oracle maps frame k to row k, so that mapping is checked here against the bytes of every
 * frame rather than assumed: one frame per acknowledged row, in write order.
 */
function tearFrame(logPath, framesFromEnd) {
	const buffer = readFileSync(logPath);
	ok(buffer.subarray(0, 4).toString() === LOG_FILE_MAGIC, `${logPath} is not a transaction log`);
	const frames = readFrames(buffer);
	ok(
		frames.length === TOTAL,
		`${logPath} holds ${frames.length} frames for ${TOTAL} rows; the oracle maps frame k to row k and needs one frame per row`
	);
	frames.forEach(({ position, length }, index) => {
		const payload = buffer.subarray(position + ENTRY_HEADER_SIZE, position + ENTRY_HEADER_SIZE + length);
		ok(payload.includes(payloadFor(rowId(index))), `frame ${index} does not carry ${rowId(index)}`);
	});
	const index = frames.length - 1 - framesFromEnd;
	ok(index > BATCH_ONE, `the torn frame (${index}) must sit past B's resume cursor (${BATCH_ONE})`);
	const target = frames[index];
	new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setUint32(target.position + 8, buffer.length);
	writeFileSync(logPath, buffer);
	return { ...target, index, totalFrames: frames.length };
}

function localLogPath(dataRootDir) {
	return join(dataRootDir, 'database', DATABASE, 'transaction_logs', 'local', `${LOG_ID}.txnlog`);
}

/** Every row on the node; a failed query fails the test rather than reading as an empty table. */
async function readRows(node, signal) {
	const rows = await sendOperation(
		node,
		{
			operation: 'search_by_value',
			database: DATABASE,
			table: TABLE,
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id', 'payload'],
		},
		{ signal }
	);
	ok(Array.isArray(rows), `expected a row array from ${node.hostname}, got ${JSON.stringify(rows)}`);
	return rows;
}

/** Bounded wait for the node to hold at least `count` rows; a query that fails while it settles is a retry. */
function waitForRowCount(node, count) {
	return waitForCondition(
		async (signal) => {
			const rows = await readRows(node, signal).catch(() => null);
			return rows && rows.length >= count ? rows : null;
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: () => `${node.hostname} to hold ${count} rows` }
	);
}

function assertExactRows(rows, expectedIds, when) {
	const byId = new Map(rows.map((row) => [row.id, row.payload]));
	const missing = expectedIds.filter((id) => !byId.has(id));
	const extra = [...byId.keys()].filter((id) => !expectedIds.includes(id));
	ok(
		missing.length === 0 && extra.length === 0,
		`${when}: expected exactly ${expectedIds.length} rows; missing ${missing.length} [${missing.join(', ')}], ` +
			`unexpected ${extra.length} [${extra.join(', ')}]`
	);
	for (const id of expectedIds) {
		strictEqual(byId.get(id), payloadFor(id), `${when}: ${id} does not hold the payload that was written`);
	}
}

async function insertRows(node, from, count) {
	await sendOperation(node, {
		operation: 'insert',
		database: DATABASE,
		table: TABLE,
		records: rowIds(from, count).map((id) => ({ id, payload: payloadFor(id) })),
	});
}
