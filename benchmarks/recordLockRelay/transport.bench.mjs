/**
 * What an off-owner `lock()` pays for its transport (harper-pro#852). A measurement, not a gate:
 * nothing here asserts a threshold, and it needs no cluster — one process, one extra worker.
 *
 *   npm run bench:record-lock-relay
 *
 * At `threads.count = N` one worker coordinates a database and the other N-1 relay every `lock()`
 * to it, so `(N-1)/N` of locks pay a thread round trip that an on-owner lock does not. These rows
 * are the candidates for carrying that, against the on-owner admission as the floor:
 *
 *   A   worker-to-worker postMessage round trip — what `recordLockRpc.ts` does today
 *   B   `db.notify()` round trip — the same request/reply shape over rocksdb-js's event transport
 *   C   `getUserSharedBuffer` + `Atomics` — admitting LOCALLY against shared delegation state
 *   D   `tryLock`/`unlock` — the native key lock, for scale
 *   E   the owner's own JS-map admission — the floor, and what `(1/N)` of locks already cost
 *
 * A and B are also measured with the coordinating worker busy, because both are answered from its
 * event loop and neither can be answered before its current turn ends. C is not, because a local
 * admission never waits on another thread — that difference is the reason the row is here.
 *
 * Results print as a table and land in JSON (`RECORD_LOCK_RELAY_BENCH_OUT`).
 */
import { MessageChannel, Worker } from 'node:worker_threads';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { RocksDatabase } from '@harperfast/rocksdb-js';

const SAMPLES = Number(process.env.RECORD_LOCK_RELAY_BENCH_N) || 3_000;
const WARMUP = Math.max(1, Math.floor(SAMPLES / 10));
const OWNER_LOAD_MS = [0.25, 1];
const OUT = process.env.RECORD_LOCK_RELAY_BENCH_OUT || join(tmpdir(), `record-lock-relay-${Date.now()}.json`);

/** The shape a relayed acquire actually carries, so serialization cost is the real one. */
const DATABASE = 'data';
const TABLE = 'Counter';
const KEY = 'record-key-000000000042';
const LEASE_MS = 30_000;
const WAIT_MS = 5_000;
/** The generation a live delegation would carry in the shared slot; any fixed value will do. */
const GENERATION = 7;

const db = new RocksDatabase(join(mkdtempSync(join(tmpdir(), 'record-lock-relay-')), 'db'));
db.open();

const rows = [];

function record(label, samples, note) {
	samples.sort((a, b) => a - b);
	const at = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
	rows.push({
		label,
		note,
		n: samples.length,
		min: samples[0],
		p50: at(0.5),
		p95: at(0.95),
		p99: at(0.99),
		max: samples[samples.length - 1],
		mean: samples.reduce((total, sample) => total + sample, 0) / samples.length,
	});
}

/** Time `once` `SAMPLES` times, discarding a warmup the JIT and the port's first sends pay for. */
async function measure(once) {
	const samples = [];
	for (let i = 0; i < SAMPLES + WARMUP; i++) {
		const started = performance.now();
		await once();
		if (i >= WARMUP) samples.push(performance.now() - started);
	}
	return samples;
}

const { port1, port2 } = new MessageChannel();
const worker = new Worker(new URL('./coordinatorWorker.mjs', import.meta.url), {
	workerData: { path: db.path, port: port2, session: 'benchsession' },
	transferList: [port2],
});
await new Promise((resolve) => worker.once('message', resolve));

const replyWaiters = new Map();
port1.on('message', (message) => replyWaiters.get(message.requestId)?.(message));
let nextRequestId = 1;

/** Resolve when the reply for a request id arrives, whichever transport carried it. */
function awaitingReply(send) {
	return new Promise((resolve) => {
		const requestId = nextRequestId++;
		replyWaiters.set(requestId, (message) => {
			replyWaiters.delete(requestId);
			resolve(message);
		});
		send(requestId);
	});
}

/** Set the coordinating worker's per-turn load and wait for it to take effect. */
const setOwnerLoad = (busyMs) => awaitingReply((requestId) => port1.postMessage({ type: 'load', requestId, busyMs }));

// ---- A: worker-to-worker postMessage, and the same under owner load ----------------------------

const postMessageAcquire = () =>
	awaitingReply((requestId) =>
		port1.postMessage({
			type: 'acquire',
			requestId,
			database: DATABASE,
			table: TABLE,
			key: KEY,
			leaseMs: LEASE_MS,
			waitMs: WAIT_MS,
		})
	);

record('A  postMessage round trip (today)', await measure(postMessageAcquire));
for (const busyMs of OWNER_LOAD_MS) {
	await setOwnerLoad(busyMs);
	record(`A' same, owner busy ${busyMs} ms/turn`, await measure(postMessageAcquire));
}
await setOwnerLoad(0);

// ---- B: the same request/reply over notify() ---------------------------------------------------

db.on('lock-acquire-reply', (message) => replyWaiters.get(message.requestId)?.(message));
const notifyAcquire = () =>
	awaitingReply((requestId) =>
		db.notify('lock-acquire', {
			requestId,
			database: DATABASE,
			table: TABLE,
			key: KEY,
			leaseMs: LEASE_MS,
			waitMs: WAIT_MS,
		})
	);

record('B  notify() round trip', await measure(notifyAcquire));
for (const busyMs of OWNER_LOAD_MS) {
	await setOwnerLoad(busyMs);
	record(`B' same, owner busy ${busyMs} ms/turn`, await measure(notifyAcquire));
}
await setOwnerLoad(0);

// ---- C: admitting locally against shared delegation state --------------------------------------
// The whole hot-path check the coordinator runs today, over a shared slot instead of its own maps:
// not recalled, the delegation's generation is still current, and enough lease is left for the whole
// admission. Both rows are measured because the `getUserSharedBuffer` call — not the atomics — is
// what a per-key slot costs, so whether a caller can cache the handle decides the row.
const SLOT_BYTES = 32;
const RECALLED = 3;
const NEXT_ADMISSION_ID = 4;
const HOLDERS = 5;
const sharedSlotKey = ['record-lock', DATABASE, TABLE, KEY];
const holderBit = 1 << 3;

/**
 * NOT a shape to copy into the real fast path as written: `expiry` is shared across threads while
 * `performance.now()` is per-thread — every worker has its own `performance.timeOrigin`, so the
 * comparison below is only meaningful because this bench seeds and reads the slot within one origin.
 * A production slot has to carry `Date.now()`, or a monotonic value offset to one agreed origin,
 * or it would reject live leases and admit expired ones depending on thread start order. The row
 * this measures is the COST of an atomic slot read, which that correction does not change.
 */
function admitLocally(words, expiry) {
	const live =
		Atomics.load(words, RECALLED) === 0 &&
		Atomics.load(words, 0) === GENERATION &&
		expiry[0] - performance.now() >= LEASE_MS;
	if (!live) return;
	Atomics.add(words, NEXT_ADMISSION_ID, 1);
	Atomics.or(words, HOLDERS, holderBit);
}

/** Seed the slot as a live delegation the owner installed, so the rows below measure the ADMIT path.
 * A fresh shared buffer is zeroed, and a zeroed slot reads as generation 0 with an elapsed expiry —
 * which short-circuits before either write and would time the reject instead. */
function seedLiveDelegation(words, expiry) {
	Atomics.store(words, 0, GENERATION);
	Atomics.store(words, RECALLED, 0);
	Atomics.store(words, NEXT_ADMISSION_ID, 1);
	expiry[0] = performance.now() + 1e9;
}

/** Fail loudly rather than reporting a reject path's timing as an admission's. */
function assertAdmitted(words, before, label) {
	const minted = Atomics.load(words, NEXT_ADMISSION_ID) - before;
	if (minted !== SAMPLES + WARMUP)
		throw new Error(`${label} admitted ${minted} of ${SAMPLES + WARMUP} samples; the row would not be an admission`);
}

const slot = db.getUserSharedBuffer(sharedSlotKey, new ArrayBuffer(SLOT_BYTES));
const slotWords = new Int32Array(slot, 0, 6);
const slotExpiry = new Float64Array(slot, 24, 1);
seedLiveDelegation(slotWords, slotExpiry);

let mintedBefore = Atomics.load(slotWords, NEXT_ADMISSION_ID);
const perAcquireSamples = await measure(() => {
	const fetched = db.getUserSharedBuffer(sharedSlotKey, new ArrayBuffer(SLOT_BYTES));
	admitLocally(new Int32Array(fetched, 0, 6), new Float64Array(fetched, 24, 1));
});
assertAdmitted(slotWords, mintedBefore, 'C');
record('C  getUserSharedBuffer + Atomics admit', perAcquireSamples, 'no cross-thread wait');

mintedBefore = Atomics.load(slotWords, NEXT_ADMISSION_ID);
const cachedSamples = await measure(() => admitLocally(slotWords, slotExpiry));
assertAdmitted(slotWords, mintedBefore, 'C2');
record('C2 Atomics admit, slot handle cached', cachedSamples, 'no cross-thread wait');

// ---- D: the native key lock, for scale ---------------------------------------------------------

record(
	'D  tryLock + unlock',
	await measure(() => {
		db.tryLock(KEY);
		db.unlock(KEY);
	}),
	'for scale'
);

// ---- E: the owner's own admission, the floor ---------------------------------------------------
// `LockCoordinator.#admit`: prune, mint an id, record the admission, count it as holding. The map is
// cleared past a bound so the row measures the admission rather than an unbounded map's growth —
// core sweeps the same entries on expiry (`#pruneAdmissions`).
const ADMISSION_BOUND = 4_096;
const admissionsById = new Map();
const delegation = {
	generation: GENERATION,
	expiresMono: performance.now() + 1e9,
	recalled: false,
	admissions: new Map(),
	holding: 0,
};
let nextAdmissionId = 1;

record(
	'E  on-owner local admit (JS maps)',
	await measure(() => {
		if (
			!delegation.recalled &&
			delegation.generation === GENERATION &&
			delegation.expiresMono - performance.now() >= LEASE_MS
		) {
			const mintedMono = performance.now();
			const admissionId = nextAdmissionId++;
			delegation.admissions.set(admissionId, { revoke: undefined, expiresMono: mintedMono + LEASE_MS, holding: true });
			delegation.holding++;
			admissionsById.set(admissionId, delegation);
		}
		if (admissionsById.size > ADMISSION_BOUND) {
			admissionsById.clear();
			delegation.admissions.clear();
		}
	}),
	'the floor'
);

// ---- report ------------------------------------------------------------------------------------

const ms = (value) => (value < 1 ? value.toFixed(4) : value.toFixed(2));
const cell = (value, width) => String(value).padEnd(width);
const header = ['ms', 'n', 'min', 'p50', 'p95', 'p99', 'max', 'mean'];
const widths = [38, 6, 8, 8, 8, 8, 8, 8];

console.log(`\n${SAMPLES} samples per row, Node ${process.version}, ${process.platform} ${process.arch}\n`);
console.log(`| ${header.map((name, i) => cell(name, widths[i])).join(' | ')} |`);
console.log(`| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`);
for (const row of rows)
	console.log(
		`| ${[row.label, row.n, ms(row.min), ms(row.p50), ms(row.p95), ms(row.p99), ms(row.max), ms(row.mean)]
			.map((value, i) => cell(value, widths[i]))
			.join(' | ')} |`
	);
console.log();
for (const row of rows) if (row.note) console.log(`${row.label} — ${row.note}`);

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
			samples: SAMPLES,
			rows,
		},
		undefined,
		'\t'
	)}\n`
);
console.log(`\nraw: ${OUT}`);

await worker.terminate();
db.close();
