/**
 * Mid-log transaction-log tear: replication stops at the break and reports it.
 *
 * A partial `ENOSPC`/`EDQUOT` append the process survives can leave one unreadable frame in a
 * source's transaction log with intact, already-acknowledged entries behind it. The policy for that
 * shape is fail-stop (harper#2087): the stream delivers everything before the break, stops there
 * rather than skipping the frame -- a frame is not a transaction boundary, so skipping it could
 * apply part of a source transaction -- and reports the break with the offset where framing
 * resumes. Repairing the log and restarting the source revives later transactions, but B's resume
 * cursor is already exclusive of the torn transaction, so its remainder needs a re-clone.
 *
 * The torn frame sits inside the 50-row source transaction, so B's exact prefix is part of a
 * transaction it does not receive in full. Streaming replication commits what it drained; #2087's
 * atomic discard of a truncated transaction is the crash-recovery replay arm, not exercised here.
 *
 * B joins at the log key of a seed entry A writes first (`add_node` `start_time`), so none of B's
 * subscriptions can resolve to a base copy of A's intact table, which never reads the torn log.
 * Without it, B's restart full-copies whenever its resume cursor was not yet persisted when B was
 * stopped: the cursor trails applied rows, and after a copy it waits on a memtable flush. B's copy of
 * the seed table staying empty is the evidence.
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

const engine = await import('@harperfast/rocksdb-js');
// An entry header is a big-endian float64 timestamp, a uint32 payload length, and a flag byte.
const { TRANSACTION_LOG_FILE_HEADER_SIZE: FILE_HEADER_SIZE, TRANSACTION_LOG_ENTRY_HEADER_SIZE: ENTRY_HEADER_SIZE } =
	engine.constants;
const LOG_FILE_MAGIC = 'WOOF';
const LOG_ID = 1;

const DATABASE = 'data';
const TABLE = 'torn';
const SEED_TABLE = 'seed';
const SEED_ID = 'seed';
const BATCH_ONE = 10;
const BATCH_TWO = 50;
const TOTAL = BATCH_ONE + BATCH_TWO;

// Frames left intact after the tear. rocksdb-js needs a run of 8 well-formed frames to call the
// break mid-log rather than a torn tail, and every one of them is a row B must NOT receive.
const FRAMES_AFTER_TEAR = 20;

const CONVERGE_TIMEOUT_MS = 90_000;
const REPORT_TIMEOUT_MS = 30_000;
// Every direct operation is bounded, so a node that accepts the socket and never answers fails the
// step it belongs to instead of hanging the file until the suite timeout.
const OPERATION_TIMEOUT_MS = 30_000;
// Window in which a write behind the break may (wrongly) reach B before B is read: long enough to
// span a replication reconnect cycle, since a reconnect restarts the drain from B's cursor.
const QUARANTINE_SETTLE_MS = 10_000;

suite('Mid-log txnlog tear: replication stops at the break and reports it', { timeout: 300_000 }, (ctx) => {
	before(async () => {
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
			description: () => `the seed frame in ${seedLogPath}`,
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
		const resumedRows = await waitForRowCount(ctx.nodeB, beforeBreak.length);
		await assertNeverCopied(ctx.nodeB, 'after B resumed past its cursor');
		assertExactRows(resumedRows, beforeBreak, 'after B resumed past its cursor');

		const diagnostic = breakDiagnostic(tear);
		const logsOfA = async () => [...new Set([await readLog(stoppedA), await readLog(ctx.nodeA)])].join('\n');
		await waitForCondition(async () => diagnostic.test(await logsOfA()), {
			timeoutMs: REPORT_TIMEOUT_MS,
			description: () => `A's hdb.log to report the break as ${diagnostic}`,
		});

		// A write A acknowledges after the restart is behind the break too, so it must not arrive either.
		await insertRows(ctx.nodeA, TOTAL, 1);
		await delay(QUARANTINE_SETTLE_MS);
		const quarantined = `${QUARANTINE_SETTLE_MS}ms after A acknowledged a write behind the break`;
		assertExactRows(await readRows(ctx.nodeB), beforeBreak, quarantined);
		await assertNeverCopied(ctx.nodeB, quarantined);

		// Repair is a positive control only after the corrupt source has stopped and B is still quarantined.
		const brokenA = ctx.nodeA;
		await stopNodeProcess(brokenA);
		assertExactRows(await readRows(ctx.nodeB), beforeBreak, 'after the corrupt source stopped');
		repairFrame(localLogPath(brokenA.dataRootDir), tear);
		const repairedA = { name: ctx.name, harper: { dataRootDir: brokenA.dataRootDir, hostname: brokenA.hostname } };
		await startHarper(repairedA, nodeStartOptions(brokenA.hostname));
		ctx.nodeA = repairedA.harper;

		const probeId = rowId(TOTAL);
		const afterRepair = await waitForCondition(
			async (signal) => {
				const rows = await readRows(ctx.nodeB, signal).catch(() => null);
				return rows?.some((row) => row.id === probeId) ? rows : null;
			},
			{
				timeoutMs: CONVERGE_TIMEOUT_MS,
				description: () => `${ctx.nodeB.hostname} to receive ${probeId} after the repair`,
			}
		);
		assertRowsPresent(afterRepair, [...beforeBreak, probeId], 'after the log was repaired');
		const tornTransactionRemainder = rowIds(tear.index, TOTAL - tear.index);
		const recovered = tornTransactionRemainder.filter((id) => afterRepair.some((row) => row.id === id));
		console.log(
			`after repair B holds ${recovered.length}/${tornTransactionRemainder.length} rows of the torn transaction's remainder`
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

function readFrames(buffer) {
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

/**
 * The seed frame's header timestamp, read from A's live log. It is the entry's log key, the value A's
 * sender compares a requested start against: the retention base-copy upgrade fires only below the
 * oldest retained key, and replay starts exclusive of the requested one, so joining at exactly this
 * key streams every later write and never the seed.
 */
function readSeedLogKey(logPath) {
	let buffer;
	try {
		buffer = readFileSync(logPath);
	} catch (error) {
		if (error.code === 'ENOENT') return;
		throw error;
	}
	const [seedFrame] = readFrames(buffer);
	if (!seedFrame) return;
	ok(frameCarries(buffer, seedFrame, SEED_ID), `the first frame of ${logPath} does not carry the seed record`);
	return seedFrame.timestamp;
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
 * The oracle maps row frame k (the frames after the seed's) to row k, so that mapping is checked
 * here against the bytes of every frame rather than assumed: one frame per acknowledged row, in
 * write order. The returned `index` is that row index; `position` and `length` are physical.
 */
function tearFrame(logPath, framesFromEnd) {
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
	const index = frames.length - 1 - framesFromEnd;
	ok(index > BATCH_ONE, `the torn frame (${index}) must sit past B's resume cursor (${BATCH_ONE})`);
	const target = frames[index];
	new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setUint32(target.position + 8, buffer.length);
	writeFileSync(logPath, buffer);
	return { ...target, index, totalFrames: frames.length };
}

function repairFrame(logPath, tear) {
	const buffer = readFileSync(logPath);
	new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setUint32(tear.position + 8, tear.length);
	writeFileSync(logPath, buffer);
}

function localLogPath(dataRootDir) {
	return join(dataRootDir, 'database', DATABASE, 'transaction_logs', 'local', `${LOG_ID}.txnlog`);
}

/** A failed query fails the test rather than reading as an empty table. */
async function readRows(node, signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS), table = TABLE) {
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

// Every base-copy path walks each table of the database, so the seed on B means B was served A's
// tables rather than A's log.
async function assertNeverCopied(node, when) {
	const seedRows = await readRows(node, undefined, SEED_TABLE);
	ok(
		seedRows.length === 0,
		`${when}: ${node.hostname} holds A's seed record, so it received a base copy of A's tables instead of replaying A's log`
	);
}

function assertRowsPresent(rows, expectedIds, when) {
	const byId = new Map(rows.map((row) => [row.id, row.payload]));
	const missing = expectedIds.filter((id) => !byId.has(id));
	ok(missing.length === 0, `${when}: B is missing ${missing.length} rows [${missing.join(', ')}]`);
	for (const id of expectedIds) {
		strictEqual(byId.get(id), payloadFor(id), `${when}: ${id} does not hold the payload that was written`);
	}
}

function insertRows(node, from, count) {
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
