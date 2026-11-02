/**
 * Readable mid-log transaction-log tears (harper-pro#669).
 *
 * A partial append usually leaves the torn frame's header intact with a declared length that still
 * fits the file, so the reader yields it as an entry whose payload is its own bytes followed by its
 * neighbour's. Framing recovery cannot see this; only the consumer can, and only when the payload
 * fails to decode. Same harness as txnlogTearReplication.test.mjs (the unreadable shape); row r39's
 * frame is torn and the source keeps every acknowledged row in its table.
 *
 * - Overrun onto the next boundary: the reader yields r39 with r40's whole frame inside it, and
 *   framing resumes cleanly at r41. B drops r39 as undecodable, logs the drop and the replication
 *   hole, keeps its connection and receives every entry behind it. r40 is gone at the source, not
 *   dropped by B.
 * - Overrun into the neighbour (the issue's construction): the same undecodable r39, but the reader
 *   lands mid-way through r40, so a mid-log break follows the torn entry. B drops r39 without closing;
 *   A's fail-stop then holds back everything behind the break and reports it.
 * - Partial append, a characterization: r39's last bytes are missing, so its declared length takes in
 *   r40's header. That payload still decodes, and B stores r39 with the wrong value and reports
 *   nothing, while A's fail-stop holds back what follows. Pinned so a fix has to change it.
 */
import { suite, test, before, after } from 'node:test';
import { notStrictEqual, ok, strictEqual } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendOperation, waitForCondition } from './clusterShared.mjs';
import {
	CONVERGE_TIMEOUT_MS,
	DATABASE,
	ENTRY_HEADER_SIZE,
	OPERATION_TIMEOUT_MS,
	REPORT_TIMEOUT_MS,
	TABLE,
	TOTAL,
	assertExactRows,
	assertNeverCopied,
	breakDiagnostic,
	insertRows,
	locateTearTarget,
	payloadFor,
	readFrames,
	readLogs,
	readRows,
	resumeFromTornSource,
	rowId,
	rowIds,
	startTearPair,
	stopTearPair,
	waitForRowCount,
} from './txnlogTearShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const INBOUND_CLOSE = /Error handling incoming replication message/g;

suite(
	'Readable txnlog tear on a frame boundary: B drops the torn entry and replicates past it',
	{ timeout: 300_000 },
	(ctx) => {
		before(() => startTearPair(ctx));
		after(() => stopTearPair(ctx));

		test('B holds every row A yields behind the torn entry, logs the drop, and never closes', async () => {
			const { stoppedA, stoppedB, torn } = await resumeFromTornSource(ctx, overrunOntoBoundary);
			const tornId = rowId(torn.index);
			const behind = rowIds(torn.index + 2, TOTAL - torn.index - 2);
			await waitForRowCount(ctx.nodeB, torn.index + behind.length);

			const liveId = rowId(TOTAL);
			await insertRows(ctx.nodeA, TOTAL, 1);
			const rows = await waitForRow(ctx.nodeB, liveId);
			await assertNeverCopied(ctx.nodeB, 'after B replicated past the torn entry');
			assertExactRows(rows, [...rowIds(0, torn.index), ...behind, liveId], 'after B replicated past the torn entry');

			const logB = await waitForLog([stoppedB, ctx.nodeB], [decodeDrop(tornId), hole(ctx.nodeA)], 'B');
			strictEqual(countInboundCloses(logB), 0, 'B closed its inbound stream on the torn entry');
			const logA = await readLogs([stoppedA, ctx.nodeA]);
			ok(
				!/Corrupt entry in transaction log/.test(logA),
				'A reported a framing break the boundary overrun must not leave'
			);
			await recordStatus(ctx, rows);
		});
	}
);

suite(
	'Readable txnlog tear into the next frame: B drops the torn entry, then A stops at the break',
	{ timeout: 300_000 },
	(ctx) => {
		before(() => startTearPair(ctx));
		after(() => stopTearPair(ctx));

		test('B holds the rows before the torn entry, logs the drop, never closes, and A reports the break', async () => {
			const { stoppedA, stoppedB, torn } = await resumeFromTornSource(ctx, overrunIntoNeighbour);
			const tornId = rowId(torn.index);
			await waitForRowCount(ctx.nodeB, torn.index);
			await waitForBreakReport(ctx, stoppedA, torn);
			const logB = await waitForLog([stoppedB, ctx.nodeB], [decodeDrop(tornId), hole(ctx.nodeA)], 'B');

			const rows = await readRows(ctx.nodeB);
			await assertNeverCopied(ctx.nodeB, 'after A stopped at the break');
			assertExactRows(rows, rowIds(0, torn.index), 'after A stopped at the break');
			strictEqual(countInboundCloses(logB), 0, 'B closed its inbound stream on the torn entry');
			await recordStatus(ctx, rows);
		});
	}
);

suite(
	'Readable txnlog tear from a partial append (characterization): B applies the torn entry',
	{ timeout: 300_000 },
	(ctx) => {
		before(() => startTearPair(ctx));
		after(() => stopTearPair(ctx));

		test('B stores the torn entry with the wrong payload and reports nothing; A stops at the break behind it', async () => {
			const { stoppedA, stoppedB, torn } = await resumeFromTornSource(ctx, partialAppend);
			const tornId = rowId(torn.index);
			await waitForRowCount(ctx.nodeB, torn.index + 1);
			await waitForBreakReport(ctx, stoppedA, torn);

			const rows = await readRows(ctx.nodeB);
			await assertNeverCopied(ctx.nodeB, 'after A stopped at the break');
			const tornRow = rows.find((row) => row.id === tornId);
			ok(tornRow, `B does not hold ${tornId}`);
			assertExactRows(
				rows.filter((row) => row !== tornRow),
				rowIds(0, torn.index),
				'after A stopped at the break'
			);
			const written = payloadFor(tornId);
			notStrictEqual(tornRow.payload, written, `B holds ${tornId} intact, so the torn entry was not applied as read`);
			ok(
				tornRow.payload.startsWith(written.slice(0, -ENTRY_HEADER_SIZE)),
				`B's ${tornId} does not keep the bytes the partial append wrote: ${JSON.stringify(tornRow.payload)}`
			);

			const logB = await readLogs([stoppedB, ctx.nodeB]);
			ok(!decodeDrop(tornId).test(logB), `B reported ${tornId} as undecodable`);
			ok(!hole(ctx.nodeA).test(logB), 'B recorded a replication hole');
			strictEqual(countInboundCloses(logB), 0, 'B closed its inbound stream on the torn entry');
			console.log(`B stored ${tornId} as ${JSON.stringify(tornRow.payload)}`);
			await recordStatus(ctx, rows);
		});
	}
);

/**
 * Grows r39's declared length by exactly r40's frame, so the reader yields r39 with r40 inside its
 * payload and framing resumes cleanly at r41. The value decode then fails for any neighbour bytes:
 * msgpackr rejects a complete value followed by more data ("Data read, but end of buffer not reached").
 */
function overrunOntoBoundary(logPath) {
	const { buffer, frames, index } = locateTearTarget(logPath);
	const target = frames[index];
	const declared = target.length + ENTRY_HEADER_SIZE + frames[index + 1].length;
	setDeclaredLength(buffer, target, declared);
	writeFileSync(logPath, buffer);
	const walked = readFrames(buffer);
	const last = walked.at(-1);
	ok(
		walked.length === TOTAL && last.position + ENTRY_HEADER_SIZE + last.length === buffer.length,
		`the torn log must read as the seed and every row frame but ${rowId(index + 1)}, with no break; read ${walked.length} frames`
	);
	return { index, position: target.position, declared };
}

/** Grows r39's declared length half-way into r40, so the reader yields r39 and then hits a break. */
function overrunIntoNeighbour(logPath) {
	const { buffer, frames, index } = locateTearTarget(logPath);
	const target = frames[index];
	const declared = target.length + ENTRY_HEADER_SIZE + Math.floor(frames[index + 1].length / 2);
	setDeclaredLength(buffer, target, declared);
	writeFileSync(logPath, buffer);
	return assertBreaksAfter(buffer, target, index, declared, frames[index + 2].position);
}

/**
 * What a partial append the process survives leaves behind: r39's header declares its full length,
 * but its last ENTRY_HEADER_SIZE payload bytes were never written and r40 was appended where they
 * belong. The lost bytes are inside the payload string, whose decode never throws on garbage.
 */
function partialAppend(logPath) {
	const { buffer, frames, index } = locateTearTarget(logPath);
	const target = frames[index];
	const end = target.position + ENTRY_HEADER_SIZE + target.length;
	const lost = buffer.subarray(end - ENTRY_HEADER_SIZE, end);
	ok(
		lost.every((byte) => byte === 0x78),
		`the bytes the partial append loses must be the payload's trailing x run, got ${lost.toString('hex')}`
	);
	const torn = Buffer.concat([buffer.subarray(0, end - ENTRY_HEADER_SIZE), buffer.subarray(end)]);
	writeFileSync(logPath, torn);
	return assertBreaksAfter(torn, target, index, target.length, frames[index + 2].position - ENTRY_HEADER_SIZE);
}

function setDeclaredLength(buffer, frame, length) {
	new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setUint32(frame.position + 8, length);
}

// The reader yields the torn frame whole, then finds no frame where its declared length ends. The
// engine resumes framing at r41 (`resumesAt`), which A's break report is asserted against.
function assertBreaksAfter(buffer, target, index, declared, resumesAt) {
	const walked = readFrames(buffer);
	const breakAt = target.position + ENTRY_HEADER_SIZE + declared;
	ok(
		walked.length === index + 2 && walked.at(-1).position === target.position && breakAt < resumesAt,
		`the torn log must read up to and including ${rowId(index)} and then break; read ${walked.length} frames`
	);
	return { index, position: target.position, declared, breakAt, resumesAt };
}

function decodeDrop(id) {
	return new RegExp(`Error decoding replication message, record id: ${id}\\b`);
}

function hole(source) {
	return new RegExp(
		`Record locks: ${DATABASE}\\.${TABLE} from ${source.hostname.replaceAll('.', '\\.')} has a replication hole on this node \\(undecodable record\\)`
	);
}

function countInboundCloses(log) {
	return log.match(INBOUND_CLOSE)?.length ?? 0;
}

function waitForRow(node, id) {
	return waitForCondition(
		async (signal) => {
			const rows = await readRows(node, signal).catch(() => null);
			return rows?.some((row) => row.id === id) ? rows : null;
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: () => `${node.hostname} to receive ${id}` }
	);
}

async function waitForLog(incarnations, patterns, which) {
	return waitForCondition(
		async () => {
			const log = await readLogs(incarnations);
			return patterns.every((pattern) => pattern.test(log)) ? log : null;
		},
		{ timeoutMs: REPORT_TIMEOUT_MS, description: () => `${which}'s hdb.log to match ${patterns.join(' and ')}` }
	);
}

/** The engine's offsets for this exact break, and the sender's stop at it. */
function waitForBreakReport(ctx, stoppedA, torn) {
	const stopped = new RegExp(
		`Replication send to ${ctx.nodeB.hostname.replaceAll('.', '\\.')} \\(db: "${DATABASE}"\\) stopped at a mid-log corrupt transaction-log frame`
	);
	return waitForLog([stoppedA, ctx.nodeA], [breakDiagnostic(torn.breakAt, torn.resumesAt), stopped], 'A');
}

// Recorded rather than asserted: what an operator sees for this tear on each side.
async function recordStatus(ctx, rowsOnB) {
	for (const [name, node, peer] of [
		['A', ctx.nodeA, ctx.nodeB],
		['B', ctx.nodeB, ctx.nodeA],
	]) {
		const status = await sendOperation(
			node,
			{ operation: 'cluster_status' },
			{ signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS) }
		);
		const socket = status.connections
			?.find((connection) => connection.name === peer.hostname)
			?.database_sockets?.find((databaseSocket) => databaseSocket.database === DATABASE);
		const { connected, lastReceivedStatus, lastReceivedVersion } = socket ?? {};
		console.log(
			`cluster_status on ${name}: ${JSON.stringify({ connected, lastReceivedStatus, lastReceivedVersion, recordLocks: status.recordLocks })}`
		);
	}
	console.log(`B holds ${rowsOnB.length}/${TOTAL} of A's rows`);
}
