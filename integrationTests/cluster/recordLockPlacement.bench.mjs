/**
 * Inbound-apply cost of enabling `replication.recordLocks` on a database that never takes a lock
 * (harper-pro#977). A measurement, not a gate; the file name keeps it out of the *.test.* globs.
 *
 *   npm run bench:record-lock-placement
 *
 * One arm at a time (a 3-node full mesh at the platform-default worker count is too large to run
 * two of), `REPS` repetitions, arms interleaved rep by rep. The first `WRITER_NODES` nodes write
 * concurrently; the last node only receives, so its CPU is inbound apply alone (two streams). The
 * bench then waits for every node to hold every record.
 *
 * Reported per arm and node:
 * - writeMs: the slowest writer's wall time; convergeMs: load start → every record present here;
 *   lagMs = convergeMs - writeMs, the apply backlog once the writers stop.
 * - per-thread CPU over the load window from `/proc/<pid>/task/<tid>/stat`, sorted descending. The
 *   top entries are the threads applying the inbound streams; the point of the bench is their shape:
 *   co-located placement puts both streams on one thread, round-robin on two.
 *
 * Arms: `off` (recordLocks false) and `on` (true, home map activated, nothing ever calls lock()).
 * Run it on the base build and on the change; the output records the dist's commit.
 */
import { suite, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { basename, join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { readNodePid, sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';
import { bootstrapHomeMap, connectMesh, waitForRing } from './recordLockShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const FIXTURE = join(import.meta.dirname, 'fixture-record-lock-bench');
const DB = 'data';
const NODES = 3;
/** Nodes that write; the rest only apply. Default leaves one pure receiver. */
const WRITER_NODES = Number(process.env.RECORD_LOCK_PLACEMENT_WRITER_NODES) || NODES - 1;
const REPS = Number(process.env.RECORD_LOCK_PLACEMENT_REPS) || 3;
/** Concurrent writer requests per node and puts per request; each node applies (NODES-1) × this. */
const WRITERS_PER_NODE = Number(process.env.RECORD_LOCK_PLACEMENT_WRITERS) || 8;
const PUTS_PER_WRITER = Number(process.env.RECORD_LOCK_PLACEMENT_PUTS) || 5_000;
const PUT_BATCH = Number(process.env.RECORD_LOCK_PLACEMENT_BATCH) || 50;
/** The integration harness pins `threads.count: 1` unless told otherwise; default to what a Linux server
 * resolves on its own (`setDefaultThreads`: one less than the logical CPU count, at least 2). */
const THREADS = Number(process.env.RECORD_LOCK_PLACEMENT_THREADS) || Math.max(2, cpus().length - 1);
const CONVERGE_TIMEOUT_MS = 300_000;
const OUT = process.env.RECORD_LOCK_BENCH_OUT || join(tmpdir(), `record-lock-placement-${Date.now()}.json`);
const CLOCK_TICKS_PER_SECOND = 100;

function distCommit() {
	try {
		return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: join(import.meta.dirname, '..', '..') })
			.toString()
			.trim();
	} catch {
		return undefined;
	}
}

const results = {
	machine: {
		cpu: cpus()[0]?.model,
		cores: cpus().length,
		memoryGiB: Math.round(totalmem() / 2 ** 30),
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
	},
	build: distCommit(),
	parameters: {
		nodes: NODES,
		writerNodes: WRITER_NODES,
		reps: REPS,
		writersPerNode: WRITERS_PER_NODE,
		putsPerWriter: PUTS_PER_WRITER,
		putBatch: PUT_BATCH,
		threads: THREADS,
	},
	ranAt: new Date().toISOString(),
	runs: [],
};

function optionsFor(hostname, recordLocks) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true, level: 'warn' },
			threads: { count: THREADS },
			replication: {
				securePort: hostname + ':9933',
				databases: [DB, 'system'],
				recordLocks,
				pingInterval: 1000,
				pingTimeout: 3000,
			},
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_RECORD_LOCK_MIN_DRAIN_BACKSTOP_MS: '0' },
	};
}

async function startNode(suiteName, recordLocks) {
	const hostname = await getNextAvailableLoopbackAddress();
	const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
	await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true, dereference: true });
	const ctx = { name: suiteName, harper: { hostname, dataRootDir } };
	await startHarper(ctx, optionsFor(hostname, recordLocks));
	return ctx;
}

async function stopNode(ctx) {
	if (!ctx?.harper) return;
	await stopNodeProcess(ctx.harper).catch(() => {});
	await teardownHarper(ctx).catch((error) => console.error(`teardown of ${ctx.harper.hostname} failed:`, error));
}

async function startCluster(suiteName, recordLocks) {
	const started = await Promise.allSettled(Array.from({ length: NODES }, () => startNode(suiteName, recordLocks)));
	const contexts = started.filter((result) => result.status === 'fulfilled').map((result) => result.value);
	const failed = started.find((result) => result.status === 'rejected');
	if (failed) {
		for (const c of contexts) await stopNode(c);
		throw failed.reason;
	}
	return contexts;
}

async function call(node, path, body, signal) {
	const response = await fetch(`${node.httpURL}/${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal,
	});
	const text = await response.text();
	assert.equal(response.status, 200, `${path} on ${node.hostname}: ${response.status} ${text}`);
	return JSON.parse(text);
}

/** CPU ticks per OS thread of the node's main process: `{ tid: { comm, ticks } }`. Linux only; elsewhere the
 * CPU columns are empty and the convergence timings still stand. */
async function threadCpu(pid) {
	const out = {};
	if (process.platform !== 'linux') return out;
	for (const tid of await readdir(`/proc/${pid}/task`)) {
		let stat;
		try {
			stat = await readFile(`/proc/${pid}/task/${tid}/stat`, 'utf8');
		} catch {
			continue;
		}
		const close = stat.lastIndexOf(')');
		const comm = stat.slice(stat.indexOf('(') + 1, close);
		const fields = stat.slice(close + 2).split(' ');
		// fields[0] is state (field 3 of stat); utime and stime are fields 14 and 15.
		out[tid] = { comm, ticks: Number(fields[11]) + Number(fields[12]) };
	}
	return out;
}

function cpuDelta(before, after) {
	const rows = [];
	for (const [tid, { comm, ticks }] of Object.entries(after)) {
		const seconds = (ticks - (before[tid]?.ticks ?? 0)) / CLOCK_TICKS_PER_SECOND;
		if (seconds > 0) rows.push({ tid: Number(tid), comm, cpuSeconds: seconds });
	}
	rows.sort((a, b) => b.cpuSeconds - a.cpuSeconds);
	const total = rows.reduce((sum, row) => sum + row.cpuSeconds, 0);
	return { totalCpuSeconds: Math.round(total * 100) / 100, top: rows.slice(0, 6) };
}

async function recordCount(node, signal) {
	return (await call(node, 'BenchCount/', undefined, signal)).recordCount;
}

async function runArm(suiteName, arm, rep) {
	const contexts = await startCluster(suiteName, arm.recordLocks);
	const nodes = contexts.map((c) => c.harper);
	const writerNodes = nodes.slice(0, WRITER_NODES);
	try {
		await connectMesh(nodes);
		if (arm.recordLocks) {
			await bootstrapHomeMap(nodes);
			await waitForRing(nodes, NODES);
		}
		const pids = await Promise.all(nodes.map((node) => readNodePid(node)));
		const statuses = await Promise.all(nodes.map((node) => sendOperation(node, { operation: 'cluster_status' })));
		// Warm every writer thread and the receive paths before timing anything.
		await Promise.all(
			writerNodes.map((node, n) =>
				Promise.all(
					Array.from({ length: WRITERS_PER_NODE }, (_, w) =>
						call(node, 'BenchWriteBatched/', { prefix: `warm-${rep}-${n}-${w}`, count: 200, batch: PUT_BATCH })
					)
				)
			)
		);
		const warmTotal = WRITER_NODES * WRITERS_PER_NODE * 200;
		await waitForCondition(
			async (signal) =>
				(await Promise.all(nodes.map((node) => recordCount(node, signal)))).every((c) => c === warmTotal),
			{ timeoutMs: CONVERGE_TIMEOUT_MS, pollMs: 200, description: 'warm-up rows to converge' }
		);

		const expected = warmTotal + WRITER_NODES * WRITERS_PER_NODE * PUTS_PER_WRITER;
		const cpuBefore = await Promise.all(pids.map((pid) => threadCpu(pid)));
		const loadStarted = performance.now();
		// One lifecycle for the writers and the convergence wait: a writer failure aborts the wait and
		// every count probe, a failed wait aborts the writers, and a response that never closes after
		// its rows are visible is abandoned on a bound.
		const load = new AbortController();
		let writerFailure;
		const writers = Promise.all(
			writerNodes.map((node, n) =>
				Promise.all(
					Array.from({ length: WRITERS_PER_NODE }, (_, w) =>
						call(
							node,
							'BenchWriteBatched/',
							{ prefix: `w-${rep}-${n}-${w}`, count: PUTS_PER_WRITER, batch: PUT_BATCH },
							load.signal
						)
					)
				).then(() => performance.now() - loadStarted)
			)
		).then(
			(elapsed) => ({ elapsed }),
			(error) => {
				writerFailure = error;
				load.abort(error);
				return { error };
			}
		);
		const convergeMs = Array.from({ length: NODES }, () => undefined);
		try {
			await waitForCondition(
				async (signal) => {
					if (writerFailure) throw writerFailure;
					const counts = await Promise.all(
						nodes.map((node) => recordCount(node, AbortSignal.any([signal, load.signal])))
					);
					counts.forEach((count, i) => {
						if (count >= expected && convergeMs[i] === undefined) convergeMs[i] = performance.now() - loadStarted;
					});
					return convergeMs.every((ms) => ms !== undefined);
				},
				{ timeoutMs: CONVERGE_TIMEOUT_MS, pollMs: 500, description: `every node to hold ${expected} rows` }
			);
		} catch (error) {
			load.abort(error);
			throw error;
		}
		const responseBound = setTimeout(
			() => load.abort(new Error('writer response still open after convergence')),
			30_000
		);
		const outcome = await writers.finally(() => clearTimeout(responseBound));
		if (outcome.error) throw outcome.error;
		const writeMs = outcome.elapsed;
		const cpuAfter = await Promise.all(pids.map((pid) => threadCpu(pid)));
		const lockStatuses = await Promise.all(nodes.map((node) => sendOperation(node, { operation: 'cluster_status' })));
		return {
			arm: arm.name,
			rep,
			writeMs: writeMs.map(Math.round),
			convergeMs: convergeMs.map(Math.round),
			nodes: nodes.map((node, i) => ({
				name: statuses[i].node_name,
				role: i < WRITER_NODES ? 'writer' : 'receiver',
				ownerThreadId: lockStatuses[i].recordLocks?.[DB]?.ownerThreadId,
				// Which worker thread (Node threadId, not an OS tid) applies each inbound subscription.
				subscriptions: lockStatuses[i].connections.flatMap((connection) =>
					connection.database_sockets.map((socket) => ({
						peer: connection.name,
						database: socket.database,
						threadId: socket.threadId,
					}))
				),
				cpu: cpuDelta(cpuBefore[i], cpuAfter[i]),
			})),
		};
	} finally {
		for (const c of contexts) await stopNode(c);
	}
}

async function save() {
	await writeFile(OUT, JSON.stringify(results, null, 2) + '\n');
}

suite('record lock placement: inbound apply with no lock activity', { timeout: 3_600_000 }, (ctx) => {
	const arms = [
		{ name: 'off', recordLocks: false },
		{ name: 'on', recordLocks: true },
	];

	after(save);

	test('arms interleaved rep by rep', async (t) => {
		for (let rep = 0; rep < REPS; rep++)
			for (const arm of arms) {
				const run = await runArm(ctx.name, arm, rep);
				results.runs.push(run);
				await save();
				t.diagnostic(
					`${arm.name} rep ${rep}: write ${JSON.stringify(run.writeMs)} ms, converge ${JSON.stringify(run.convergeMs)} ms, ` +
						run.nodes
							.map(
								(node) =>
									`${node.name} top=${node.cpu.top.map((row) => row.cpuSeconds.toFixed(2)).join('/')}s of ${node.cpu.totalCpuSeconds}s`
							)
							.join('; ')
				);
			}
		t.diagnostic(`results written to ${OUT}`);
	});
});
