/**
 * Mid-log transaction-log tear: replication stops at the break and reports it.
 *
 * A partial `ENOSPC`/`EDQUOT` append the process survives can leave one unreadable frame in a
 * source's transaction log with intact, already-acknowledged entries behind it. The policy for that
 * shape is fail-stop (harper#2087): the stream delivers every transaction before the break, stops
 * there rather than skipping the frame -- a frame is not a transaction boundary, so skipping it could
 * apply part of a source transaction -- and reports the break with the offset where framing
 * resumes.
 *
 * The torn frame sits inside the 50-row source transaction. The sender withholds that transaction
 * whole rather than send the entries before the break (harper-pro#1475), so B keeps only the first
 * batch, and its resume cursor stays before the torn transaction: repairing the log and restarting
 * the source delivers it in full.
 *
 * The two-node harness, including how B's join avoids a base copy, is in txnlogTearShared.mjs.
 *
 * Not covered: the readable tear shapes, where the torn frame is yielded with its neighbour's bytes
 * (txnlogReadableTearReplication.test.mjs); a torn tail; `cluster_status` surfacing the break
 * (harper-pro#667); and the write side that lets a tear happen at all (rocksdb-js#748).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarper } from '@harperfast/integration-testing';
import { stopNodeProcess, waitForCondition } from './clusterShared.mjs';
import {
	BATCH_ONE,
	CONVERGE_TIMEOUT_MS,
	ENTRY_HEADER_SIZE,
	FRAMES_AFTER_TEAR,
	QUARANTINE_SETTLE_MS,
	REPORT_TIMEOUT_MS,
	TOTAL,
	assertExactRows,
	assertNeverCopied,
	breakDiagnostic,
	insertRows,
	localLogPath,
	locateTearTarget,
	nodeStartOptions,
	payloadFor,
	readLogs,
	readRows,
	resumeFromTornSource,
	rowId,
	rowIds,
	startTearPair,
	stopTearPair,
} from './txnlogTearShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const WITHHELD = /Withholding transaction \S+ from \S+ on data: a corrupt transaction-log frame cut it short/;

suite('Mid-log txnlog tear: replication stops at the break and reports it', { timeout: 300_000 }, (ctx) => {
	before(() => startTearPair(ctx));

	after(() => stopTearPair(ctx));

	test('B receives every transaction before the torn one, nothing of it or behind it, and A reports the break', async () => {
		const { stoppedA, torn: tear } = await resumeFromTornSource(ctx, tearFrame);
		const beforeBreak = rowIds(0, BATCH_ONE);
		console.log(
			`tore frame ${tear.index} (${rowId(tear.index)}) @${tear.position} (len ${tear.length}) of ${tear.totalFrames}; ` +
				`${FRAMES_AFTER_TEAR} frames follow it`
		);

		// B already held the first batch; A withholds the torn transaction once its drain reaches the break.
		const diagnostic = breakDiagnostic(tear.position, tear.position + ENTRY_HEADER_SIZE + tear.length);
		await waitForCondition(
			async () => {
				const log = await readLogs([stoppedA, ctx.nodeA]);
				return diagnostic.test(log) && WITHHELD.test(log);
			},
			{
				timeoutMs: REPORT_TIMEOUT_MS,
				description: () => `A's hdb.log to report the break as ${diagnostic} and to withhold the torn transaction`,
			}
		);
		await assertNeverCopied(ctx.nodeB, 'after B resumed past its cursor');
		assertExactRows(await readRows(ctx.nodeB), beforeBreak, 'after B resumed past its cursor');

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
		// B's cursor never passed the torn transaction, so the repaired log delivers all of it
		assertRowsPresent(afterRepair, [...rowIds(0, TOTAL), probeId], 'after the log was repaired');
	});
});

/**
 * Breaks one frame by declaring a length the file cannot satisfy, so the reader cannot read the
 * frame at all and must find where framing resumes.
 *
 * This is the *unreadable* tear shape. The other shape a partial append can leave -- a declared
 * length that overruns into the following frame but still fits the file -- is readable, so the
 * reader yields it as an entry whose payload is the torn bytes plus its neighbour's; only the
 * consumer can tell it is garbage (txnlogReadableTearReplication.test.mjs).
 */
function tearFrame(logPath) {
	const { buffer, frames, index } = locateTearTarget(logPath);
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

function assertRowsPresent(rows, expectedIds, when) {
	const byId = new Map(rows.map((row) => [row.id, row.payload]));
	const missing = expectedIds.filter((id) => !byId.has(id));
	ok(missing.length === 0, `${when}: B is missing ${missing.length} rows [${missing.join(', ')}]`);
	for (const id of expectedIds) {
		strictEqual(byId.get(id), payloadFor(id), `${when}: ${id} does not hold the payload that was written`);
	}
}
