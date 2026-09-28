/**
 * harper-pro#865 ledger item 5 / rocksdb-js#865: a worker's EXIT is counted as a completed fence on
 * the ownerless-handoff path, and the argument for that is the process-wide native key lock. But a
 * handle is revoked after `unlock()` has already returned the key (`core/resources/recordLock.ts`
 * `revokeLease()`), so the key lock does not cover a staged write still in flight. The open question
 * has been whether a commit already handed to the engine can outlive the thread that issued it, and
 * land after a successor was admitted.
 *
 *   npm run probe:record-lock-exit-commit
 *
 * Two things are measured, because they have different answers:
 *
 *   1. SURVIVAL — does an abandoned commit still land? The doomed worker hands `count` writes to the
 *      engine, is terminated, and the parent counts how many became visible.
 *   2. ORDERING — can the doomed worker's write land AFTER a successor's write to the same key?
 *      That, not survival, is the lost update exit-as-fenced would allow. The parent writes every
 *      contested key as the successor and reports who won each one.
 *
 * `AWAIT_TERMINATE=0` starts the successor without awaiting `worker.terminate()`, because awaiting it
 * would let the runtime drain the thread first — which is the assumption under test.
 *
 * A measurement, not a gate: `.probe.` keeps it out of the `*.test.*` globs, and nothing here asserts.
 */
import { Worker } from 'node:worker_threads';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { RocksDatabase } from '@harperfast/rocksdb-js';

const COUNT = Number(process.env.RECORD_LOCK_EXIT_COUNT) || 4_000;
const VALUE_BYTES = Number(process.env.RECORD_LOCK_EXIT_VALUE_BYTES) || 131_072;
const TRIALS = Number(process.env.RECORD_LOCK_EXIT_TRIALS) || 5;
const AWAIT_TERMINATE = process.env.AWAIT_TERMINATE !== '0';
const MODES = (process.env.RECORD_LOCK_EXIT_MODES || 'put,transaction').split(',');
const OUT = process.env.RECORD_LOCK_EXIT_OUT || join(tmpdir(), `record-lock-exit-commit-${Date.now()}.json`);

async function trial(mode) {
	const db = new RocksDatabase(join(mkdtempSync(join(tmpdir(), 'record-lock-exit-')), 'db'));
	db.open();
	const worker = new Worker(new URL('./doomedWorker.mjs', import.meta.url), {
		workerData: { path: db.path, count: COUNT, valueBytes: VALUE_BYTES, mode },
	});
	const handed = await new Promise((resolve) => worker.once('message', resolve));

	const terminating = worker.terminate();
	if (AWAIT_TERMINATE) await terminating;
	const terminatedAt = performance.now();

	let survived = 0;
	for (let i = 0; i < COUNT; i++) if (db.get(`contested-${i}`) !== undefined) survived++;

	// The successor: admitted only because the exit was counted as a fence, writing the same keys.
	const successorWrites = [];
	for (let i = 0; i < COUNT; i++) successorWrites.push(db.put(`contested-${i}`, { writer: 'successor', i }));
	await Promise.all(successorWrites);
	const successorCommitMs = performance.now() - terminatedAt;

	let doomedWon = 0;
	for (let i = 0; i < COUNT; i++) if (db.get(`contested-${i}`)?.writer === 'doomed') doomedWon++;
	db.close();

	return {
		mode,
		handedOff: handed.handedOff,
		stalledAtHandoff: handed.stalledAtHandoff,
		survivedTerminate: survived,
		doomedWonTheKey: doomedWon,
		successorWon: COUNT - doomedWon,
		successorCommitMs: Number(successorCommitMs.toFixed(3)),
	};
}

const trials = [];
for (const mode of MODES) for (let i = 0; i < TRIALS; i++) trials.push(await trial(mode));

console.log(
	`\n${COUNT} contested keys x ${VALUE_BYTES} B, ${TRIALS} trial(s) per mode, awaitTerminate=${AWAIT_TERMINATE}, Node ${process.version}\n`
);
console.log('| mode        | survived terminate | doomed won | successor won | successor commit ms |');
console.log('| ----------- | ------------------ | ---------- | ------------- | ------------------- |');
for (const t of trials)
	console.log(
		`| ${t.mode.padEnd(11)} | ${`${t.survivedTerminate} / ${COUNT}`.padEnd(18)} | ${String(t.doomedWonTheKey).padEnd(10)} | ${String(t.successorWon).padEnd(13)} | ${String(t.successorCommitMs).padEnd(19)} |`
	);
const inversions = trials.reduce((total, t) => total + t.doomedWonTheKey, 0);
console.log(
	`\nabandoned commits that still landed: ${trials.reduce((total, t) => total + t.survivedTerminate, 0)} of ${trials.length * COUNT}` +
		`\nordering inversions (a dead worker's write over a successor's): ${inversions} of ${trials.length * COUNT}\n`
);

writeFileSync(
	OUT,
	`${JSON.stringify(
		{
			machine: {
				cpu: cpus()[0]?.model,
				cores: cpus().length,
				memoryGiB: Math.round(totalmem() / 1024 ** 3),
				platform: `${process.platform}-${process.arch}`,
				node: process.version,
			},
			ranAt: new Date().toISOString(),
			keysPerTrial: COUNT,
			valueBytes: VALUE_BYTES,
			awaitTerminate: AWAIT_TERMINATE,
			trials,
		},
		undefined,
		'\t'
	)}\n`
);
console.log(`raw: ${OUT}`);
