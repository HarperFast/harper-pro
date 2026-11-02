/**
 * Harness shared by the transaction-log tear cluster tests (txnlogTearReplication.test.mjs for the
 * unreadable shape, txnlogReadableTearReplication.test.mjs for the readable ones).
 *
 * Two nodes. B's resume cursor is established on a healthy stream of BATCH_ONE rows, B goes
 * offline, A acknowledges BATCH_TWO more rows in one insert, then A is stopped and its `data/local`
 * log is damaged on disk by the caller's tear function before both nodes come back.
 *
 * B joins at the log key of a seed entry A writes first (`add_node` `start_time`), so none of B's
 * subscriptions can resolve to a base copy of A's intact table, which never reads the torn log.
 * Without it, B's restart full-copies whenever its resume cursor was not yet persisted when B was
 * stopped: the cursor trails applied rows, and after a copy it waits on a memtable flush. B's copy of
 * the seed table staying empty is the evidence.
 */
import { ok, strictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	killHarper,
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { readLog, sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

export const engine = await import('@harperfast/rocksdb-js');
// An entry header is a big-endian float64 timestamp, a uint32 payload length, and a flag byte.
export const {
	TRANSACTION_LOG_FILE_HEADER_SIZE: FILE_HEADER_SIZE,
	TRANSACTION_LOG_ENTRY_HEADER_SIZE: ENTRY_HEADER_SIZE,
} = engine.constants;
const LOG_FILE_MAGIC = 'WOOF';
const LOG_ID = 1;

export const DATABASE = 'data';
export const TABLE = 'torn';
const SEED_TABLE = 'seed';
const SEED_ID = 'seed';
export const BATCH_ONE = 10;
const BATCH_TWO = 50;
export const TOTAL = BATCH_ONE + BATCH_TWO;

// Frames left intact after the tear. rocksdb-js needs a run of 8 well-formed frames to call the
// break mid-log rather than a torn tail, and every one of them is a row B must NOT receive.
export const FRAMES_AFTER_TEAR = 20;

export const CONVERGE_TIMEOUT_MS = 90_000;
export const REPORT_TIMEOUT_MS = 30_000;
// Every direct operation is bounded, so a node that accepts the socket and never answers fails the
// step it belongs to instead of hanging the file until the suite timeout.
export const OPERATION_TIMEOUT_MS = 30_000;

export async function startTearPair(ctx) {
	const startNode = async () => {
		const hostname = await getNextAvailableLoopbackAddress();
		const nodeCtx = { name: ctx.name, harper: { hostname } };
		await startHarper(nodeCtx, nodeStartOptions(hostname));
		return nodeCtx.harper;
	};
	ctx.nodeA = await startNode();
	ctx.nodeB = await startNode();

	for (const node of [ctx.nodeA, ctx.nodeB]) {
		for (const table of [SEED_TABLE, TABLE]) {
			await sendOperation(
				node,
				{
					operation: 'create_table',
					database: DATABASE,
					table,
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'payload', type: 'String' },
					],
				},
				{ signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS) }
			);
		}
	}

	await insertRecords(ctx.nodeA, SEED_TABLE, [SEED_ID]);
	const seedLogPath = localLogPath(ctx.nodeA.dataRootDir);
	const seedLogKey = await waitForCondition(() => readSeedLogKey(seedLogPath), {
		timeoutMs: OPERATION_TIMEOUT_MS,
		description: () => `the first frame of ${seedLogPath} to carry the seed record`,
	});

	await sendOperation(
		ctx.nodeB,
		{
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.nodeA.hostname,
			authorization: ctx.nodeB.admin,
			start_time: seedLogKey,
		},
		{ signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS) }
	);
}

export async function stopTearPair(ctx) {
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
}

/**
 * Runs the harness up to B resuming against the torn log: `tear(logPath)` damages A's stopped log
 * and its return value is passed back as `torn`. The stopped incarnations' handles are returned
 * because a restart replays the log before logging.root is repointed, so boot-time lines land in the
 * stopped incarnation's log dir (see replayCatchupSeam.test.mjs).
 */
export async function resumeFromTornSource(ctx, tear) {
	await insertRows(ctx.nodeA, 0, BATCH_ONE);
	assertExactRows(await waitForRowCount(ctx.nodeB, BATCH_ONE), rowIds(0, BATCH_ONE), 'before B goes offline');

	const stoppedB = ctx.nodeB;
	await killHarper({ harper: stoppedB });

	// One insert, so the torn frame sits inside a single source transaction.
	await insertRows(ctx.nodeA, BATCH_ONE, BATCH_TWO);
	assertExactRows(await readRows(ctx.nodeA), rowIds(0, TOTAL), 'on A before the tear');

	// A is stopped so the file is quiescent while it is torn.
	const stoppedA = ctx.nodeA;
	await stopNodeProcess(stoppedA);
	const torn = tear(localLogPath(stoppedA.dataRootDir));

	const restartedA = { name: ctx.name, harper: { dataRootDir: stoppedA.dataRootDir, hostname: stoppedA.hostname } };
	await startHarper(restartedA, nodeStartOptions(stoppedA.hostname));
	ctx.nodeA = restartedA.harper;
	// Only the log is torn; the source table keeps every acknowledged row.
	assertExactRows(await readRows(ctx.nodeA), rowIds(0, TOTAL), 'on A after the restart');

	const restartedB = { name: ctx.name, harper: { dataRootDir: stoppedB.dataRootDir, hostname: stoppedB.hostname } };
	await startHarper(restartedB, nodeStartOptions(stoppedB.hostname));
	ctx.nodeB = restartedB.harper;
	return { stoppedA, stoppedB, torn };
}

export function nodeStartOptions(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true },
			replication: { securePort: hostname + ':9933', databases: [DATABASE] },
		},
	};
}

export function rowId(index) {
	return `r${index}`;
}

export function rowIds(from, count) {
	return Array.from({ length: count }, (_, i) => rowId(from + i));
}

// Id-specific and delimited, so a row's value proves which row it is and a frame's bytes prove which
// row the frame carries (`r1:` cannot match inside `r10:`).
export function payloadFor(id) {
	return `${id}:${'x'.repeat(60)}`;
}

/**
 * The engine's report for a break at `position` with framing resuming at `resumesAt`. Core logs the
 * error's message whatever level it chooses for the line, so this keys on the two offset clauses and
 * nothing else.
 */
export function breakDiagnostic(position, resumesAt) {
	const unreadable = resumesAt - position;
	const clause = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(
		`${clause(`at position ${position.toString(16)} of log ${LOG_ID}`)}[^\\n]*` +
			clause(`valid framing resumes at ${resumesAt.toString(16)}, ${unreadable} byte(s) unreadable`)
	);
}

/** Walks frames from the file header with the reader's own framing rules, stopping at the first break. */
export function readFrames(buffer) {
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const frames = [];
	let position = FILE_HEADER_SIZE;
	while (position + ENTRY_HEADER_SIZE <= buffer.length) {
		const timestamp = view.getFloat64(position);
		if (timestamp === 0) break;
		const length = view.getUint32(position + 8);
		if (length === 0 || position + ENTRY_HEADER_SIZE + length > buffer.length) break;
		frames.push({ position, length, timestamp });
		position += ENTRY_HEADER_SIZE + length;
	}
	return frames;
}

function frameCarries(buffer, { position, length }, id) {
	return buffer.subarray(position + ENTRY_HEADER_SIZE, position + ENTRY_HEADER_SIZE + length).includes(payloadFor(id));
}

// The header timestamp is the entry's log key. A's sender upgrades a start to a base copy only below
// its oldest retained key and replays exclusive of the start, so this exact key streams every later
// write and never the seed.
function readSeedLogKey(logPath) {
	let buffer;
	try {
		buffer = readFileSync(logPath);
	} catch (error) {
		if (error.code === 'ENOENT') return;
		throw error;
	}
	const [seedFrame] = readFrames(buffer);
	if (seedFrame && frameCarries(buffer, seedFrame, SEED_ID)) return seedFrame.timestamp;
}

/**
 * Reads A's stopped log and picks the frame to tear, FRAMES_AFTER_TEAR frames from the end.
 *
 * The oracle maps row frame k (the frames after the seed's) to row k, so that mapping is checked
 * here against the bytes of every frame rather than assumed: one frame per acknowledged row, in
 * write order. The returned `index` is that row index; `frames` holds the row frames only, with
 * physical `position` and `length`.
 */
export function locateTearTarget(logPath) {
	const buffer = readFileSync(logPath);
	ok(buffer.subarray(0, 4).toString() === LOG_FILE_MAGIC, `${logPath} is not a transaction log`);
	const [seedFrame, ...frames] = readFrames(buffer);
	ok(
		seedFrame && frameCarries(buffer, seedFrame, SEED_ID),
		`the first frame of ${logPath} does not carry the seed record`
	);
	ok(
		frames.length === TOTAL,
		`${logPath} holds ${frames.length} row frames for ${TOTAL} rows; the oracle maps row frame k to row k and needs one frame per row`
	);
	frames.forEach((frame, index) => {
		ok(frameCarries(buffer, frame, rowId(index)), `row frame ${index} does not carry ${rowId(index)}`);
	});
	const index = frames.length - 1 - FRAMES_AFTER_TEAR;
	ok(index > BATCH_ONE, `the torn frame (${index}) must sit past B's resume cursor (${BATCH_ONE})`);
	return { buffer, frames, index };
}

export function localLogPath(dataRootDir) {
	return join(dataRootDir, 'database', DATABASE, 'transaction_logs', 'local', `${LOG_ID}.txnlog`);
}

/** Both incarnations' hdb.log, deduplicated, as one string. */
export async function readLogs(nodes) {
	return [...new Set(await Promise.all(nodes.map((node) => readLog(node))))].join('\n');
}

/** A failed query fails the test rather than reading as an empty table. */
export async function readRows(node, signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS), table = TABLE) {
	const rows = await sendOperation(
		node,
		{
			operation: 'search_by_value',
			database: DATABASE,
			table,
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id', 'payload'],
		},
		{ signal }
	);
	ok(Array.isArray(rows), `expected a row array from ${node.hostname}, got ${JSON.stringify(rows)}`);
	return rows;
}

// A query that fails while the node settles is a retry, not a failure.
export function waitForRowCount(node, count) {
	return waitForCondition(
		async (signal) => {
			const rows = await readRows(node, signal).catch(() => null);
			return rows && rows.length >= count ? rows : null;
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: () => `${node.hostname} to hold ${count} rows` }
	);
}

export function assertExactRows(rows, expectedIds, when) {
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

// Every base-copy path walks every table of the database, the seed's included.
export async function assertNeverCopied(node, when) {
	const seedRows = await readRows(node, undefined, SEED_TABLE);
	ok(
		seedRows.length === 0,
		`${when}: ${node.hostname} holds A's seed record, so it received a base copy of A's tables instead of replaying A's log`
	);
}

export function insertRows(node, from, count) {
	return insertRecords(node, TABLE, rowIds(from, count));
}

async function insertRecords(node, table, ids) {
	await sendOperation(
		node,
		{
			operation: 'insert',
			database: DATABASE,
			table,
			records: ids.map((id) => ({ id, payload: payloadFor(id) })),
		},
		{ signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS) }
	);
}
