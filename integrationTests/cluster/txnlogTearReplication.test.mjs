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
	waitForRowCount,
} from './txnlogTearShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

suite('Mid-log txnlog tear: replication stops at the break and reports it', { timeout: 300_000 }, (ctx) => {
	before(() => startTearPair(ctx));

	after(() => stopTearPair(ctx));

	test('B receives every entry before the torn frame, nothing behind it, and A reports the break', async () => {
		const { stoppedA, torn: tear } = await resumeFromTornSource(ctx, tearFrame);
		const beforeBreak = rowIds(0, tear.index);
		console.log(
			`tore frame ${tear.index} (${rowId(tear.index)}) @${tear.position} (len ${tear.length}) of ${tear.totalFrames}; ` +
				`${FRAMES_AFTER_TEAR} frames follow it`
		);

		// The sender commits the drained prefix when the drain ends, after it discovered the break, so
		// the prefix must have landed before the diagnostic is read and the negative window opens.
		const resumedRows = await waitForRowCount(ctx.nodeB, beforeBreak.length);
		await assertNeverCopied(ctx.nodeB, 'after B resumed past its cursor');
		assertExactRows(resumedRows, beforeBreak, 'after B resumed past its cursor');

		const diagnostic = breakDiagnostic(tear.position, tear.position + ENTRY_HEADER_SIZE + tear.length);
		await waitForCondition(async () => diagnostic.test(await readLogs([stoppedA, ctx.nodeA])), {
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
