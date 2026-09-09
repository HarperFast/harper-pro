/**
 * Cost baseline for cluster record locks (harper-pro#822): the numbers its enablement gate calls for,
 * measured on the same 3-node full mesh recordLockCluster.test.mjs proves correct. A measurement, not
 * a gate — nothing here asserts a threshold, and the file name keeps it out of the *.test.* globs.
 *
 *   npm run bench:record-locks
 *
 * Results land in a JSON file (RECORD_LOCK_BENCH_OUT, default under the OS tmpdir) and the summary is
 * printed as test diagnostics. Timing happens inside the nodes (fixture-record-lock-bench), so the
 * distributions are the lock machinery's, not the HTTP client's.
 *
 * 1. Uncontended acquisition latency: distinct keys, each node in turn.
 * 2. Repeat-lock latency: one node, one key, over and over (the before-figure for a protocol that
 *    would collapse this to a local key lock).
 * 3. Hot-key handoff throughput: 2 then 3 nodes contending on one key, one lock → increment → unlock
 *    request in flight per node (the request transaction's commit is the unlock). Lock and section
 *    times are the node's own; the request round trip is the client's view.
 * 4. Transaction-log cost per acquisition: control entries and value bytes per node, from the log.
 * 5. Cost when off: unlocked write throughput with recordLocks off, with no transport registered at
 *    all (the database is not replicated), and with it on but unused.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { basename, join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const FIXTURE = join(import.meta.dirname, 'fixture-record-lock-bench');
const DB = 'data';
const CONVERGE_TIMEOUT_MS = 90_000;

const UNCONTENDED_PER_NODE = 120;
const REPEAT_ACQUISITIONS = 200;
const HOT_KEY_MS = Number(process.env.RECORD_LOCK_BENCH_HOT_KEY_MS) || 15_000;
const WRITE_BATCH = 500;
const WRITE_ROUNDS = 30;
const OUT = process.env.RECORD_LOCK_BENCH_OUT || join(tmpdir(), `record-lock-cost-${Date.now()}.json`);

const results = {
	machine: {
		cpu: cpus()[0]?.model,
		cores: cpus().length,
		memoryGiB: Math.round(totalmem() / 2 ** 30),
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
	},
	ranAt: new Date().toISOString(),
};

function replicationFor(hostname, overrides) {
	return {
		securePort: hostname + ':9933',
		databases: [DB, 'system'],
		pingInterval: 1000,
		pingTimeout: 3000,
		...overrides,
	};
}

function optionsFor(hostname, replication) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true, level: 'warn' },
			threads: { count: 1 },
			replication,
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true },
	};
}

async function startNode(suiteName, replicationOverrides) {
	const hostname = await getNextAvailableLoopbackAddress();
	const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
	await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true, dereference: true });
	const ctx = { name: suiteName, harper: { hostname, dataRootDir } };
	await startHarper(ctx, optionsFor(hostname, replicationFor(hostname, replicationOverrides)));
	return ctx;
}

async function stopNode(ctx) {
	if (!ctx?.harper) return;
	await stopNodeProcess(ctx.harper).catch(() => {});
	await teardownHarper(ctx).catch((error) => console.error(`teardown of ${ctx.harper.hostname} failed:`, error));
}

async function startAll(suiteName, overridesPerNode) {
	const started = await Promise.allSettled(overridesPerNode.map((overrides) => startNode(suiteName, overrides)));
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

async function counter(node, id, signal) {
	const response = await fetch(`${node.httpURL}/Counter/${id}`, { headers: { Accept: 'application/json' }, signal });
	if (response.status === 404) return undefined;
	const text = await response.text();
	assert.equal(response.status, 200, `GET Counter/${id} on ${node.hostname}: ${text}`);
	return JSON.parse(text);
}

async function putCounter(node, id, n) {
	const response = await fetch(`${node.httpURL}/Counter/${id}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ id, n }),
	});
	assert.ok(response.ok, `PUT Counter/${id} on ${node.hostname}: ${response.status} ${await response.text()}`);
}

function waitForCounter(nodes, id, expected) {
	return waitForCondition(
		async (signal) => {
			const values = await Promise.all(nodes.map((node) => counter(node, id, signal).then((record) => record?.n)));
			return values.every((n) => n === expected) ? values : undefined;
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: `Counter/${id} to read ${expected} on every node` }
	);
}

function waitForMesh(nodes) {
	return waitForCondition(
		async (signal) => {
			const statuses = await Promise.all(
				nodes.map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal }).catch(() => undefined))
			);
			return statuses.every(
				(status) =>
					status &&
					status.connections.length === nodes.length - 1 &&
					status.connections.every((connection) =>
						connection.database_sockets.some(
							(socket) => socket.database === DB && socket.connected && socket.peerCapabilities
						)
					)
			)
				? statuses
				: undefined;
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: 'every node to be connected to every other node' }
	);
}

async function connectMesh(nodes) {
	const { operation_token: token } = await sendOperation(nodes[0], {
		operation: 'create_authentication_tokens',
		authorization: nodes[0].admin,
	});
	for (const node of nodes.slice(1)) {
		await sendOperation(node, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: nodes[0].hostname,
			authorization: 'Bearer ' + token,
		});
	}
	return waitForMesh(nodes);
}

/** One request in flight per node until the deadline: lock → increment → unlock as the request commits. */
async function contend(node, id, durationMs) {
	const deadline = performance.now() + durationMs;
	const requestMs = [];
	const sectionMs = [];
	const lockMs = [];
	let failures = 0;
	let lastN;
	while (performance.now() < deadline) {
		const started = performance.now();
		const response = await fetch(`${node.httpURL}/LockedIncrement/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({ id }),
		});
		const body = await response.json();
		if (response.status === 423) {
			failures++;
			continue;
		}
		assert.equal(response.status, 200, `LockedIncrement on ${node.hostname}: ${JSON.stringify(body)}`);
		requestMs.push(performance.now() - started);
		sectionMs.push(body.sectionMs);
		lockMs.push(body.lockMs);
		lastN = body.n;
	}
	return { requestMs, sectionMs, lockMs, failures, lastN };
}

function percentile(sorted, p) {
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function distribution(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	const round = (n) => Math.round(n * 100) / 100;
	return {
		n: sorted.length,
		min: round(sorted[0]),
		p50: round(percentile(sorted, 50)),
		p95: round(percentile(sorted, 95)),
		p99: round(percentile(sorted, 99)),
		max: round(sorted[sorted.length - 1]),
		mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
	};
}

const LOCK_ENTRY_TYPES = ['lockRequest', 'lockGrant', 'lockRelease'];

async function logSnapshot(nodes, signal) {
	return Promise.all(nodes.map((node) => call(node, 'LogStats/', undefined, signal)));
}

/**
 * unlock() returns before the release entry is durable, so a snapshot taken straight after a batch can
 * miss its last release and carry it into the next window. Every round a node started — granted or
 * timed out — ends in exactly one release/withdraw of its own, which is the boundary waited for here.
 */
async function logSnapshotAfter(nodes, before, roundsStartedPerNode) {
	return waitForCondition(
		async (signal) => {
			const after = await logSnapshot(nodes, signal);
			const settled = nodes.every(
				(_, i) =>
					(after[i].lockRelease?.entries ?? 0) - (before[i].lockRelease?.entries ?? 0) >= roundsStartedPerNode[i]
			);
			return settled ? after : undefined;
		},
		{ timeoutMs: 30_000, pollMs: 100, description: 'every started round to have written its release' }
	);
}

/** Per node: control entries and bytes added between two snapshots, per round started. */
function logDelta(before, after, acquisitions) {
	return before.map((was, i) => {
		const now = after[i];
		const perNode = { entriesPerAcquisition: 0, bytesPerAcquisition: 0, byType: {} };
		for (const type of LOCK_ENTRY_TYPES) {
			const entries = (now[type]?.entries ?? 0) - (was[type]?.entries ?? 0);
			const bytes = (now[type]?.bytes ?? 0) - (was[type]?.bytes ?? 0);
			if (entries === 0) continue;
			perNode.byType[type] = { entries, bytes, bytesPerEntry: Math.round(bytes / entries) };
			perNode.entriesPerAcquisition += entries / acquisitions;
			perNode.bytesPerAcquisition += bytes / acquisitions;
		}
		perNode.entriesPerAcquisition = Math.round(perNode.entriesPerAcquisition * 100) / 100;
		perNode.bytesPerAcquisition = Math.round(perNode.bytesPerAcquisition);
		return perNode;
	});
}

function report(t, title, value) {
	t.diagnostic(`${title}: ${JSON.stringify(value)}`);
}

async function save() {
	await writeFile(OUT, JSON.stringify(results, null, 2) + '\n');
}

suite('record lock cost: 3-node full mesh, replication.recordLocks on', { timeout: 900_000 }, (ctx) => {
	let contexts = [];
	let nodes;

	before(async () => {
		contexts = await startAll(ctx.name, [{ recordLocks: true }, { recordLocks: true }, { recordLocks: true }]);
		nodes = contexts.map((c) => c.harper);
		await connectMesh(nodes);
		// One round per node before measuring, so participant views and the coordinator are warm.
		for (const node of nodes) await call(node, 'BenchLock/', { ids: ['warm-' + node.hostname] });
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
		await save();
	});

	test('1+4. uncontended acquisition on distinct keys, each node in turn, with the log cost per node', async (t) => {
		const perNode = [];
		const pooledAcquire = [];
		const pooledRelease = [];
		for (const [i, node] of nodes.entries()) {
			const ids = Array.from({ length: UNCONTENDED_PER_NODE }, (_, k) => `uncontended-${i}-${k}-${Date.now()}`);
			const before = await logSnapshot(nodes);
			const { acquireMs, releaseMs } = await call(node, 'BenchLock/', { ids });
			const after = await logSnapshotAfter(
				nodes,
				before,
				nodes.map((_, k) => (k === i ? ids.length : 0))
			);
			pooledAcquire.push(...acquireMs);
			pooledRelease.push(...releaseMs);
			perNode.push({
				requester: i,
				acquire: distribution(acquireMs),
				release: distribution(releaseMs),
				log: logDelta(before, after, ids.length),
			});
		}
		results.uncontended = { perNode, acquire: distribution(pooledAcquire), release: distribution(pooledRelease) };
		report(t, 'uncontended acquire ms (pooled)', results.uncontended.acquire);
		report(t, 'uncontended release ms (pooled)', results.uncontended.release);
		for (const entry of perNode) report(t, `log cost per acquisition, requester ${entry.requester}`, entry.log);
	});

	test('2. repeat-lock: one node, the same key, back to back', async (t) => {
		const id = 'repeat-' + Date.now();
		const ids = Array.from({ length: REPEAT_ACQUISITIONS }, () => id);
		const { acquireMs, releaseMs } = await call(nodes[0], 'BenchLock/', { ids });
		results.repeat = { requester: 0, acquire: distribution(acquireMs), release: distribution(releaseMs) };
		report(t, 'repeat acquire ms', results.repeat.acquire);
	});

	test('3+4. hot-key handoff throughput with 2, then 3 contending nodes', async (t) => {
		results.hotKey = [];
		for (const contenders of [2, 3]) {
			const id = `hot-${contenders}-${Date.now()}`;
			await putCounter(nodes[0], id, 0);
			await waitForCounter(nodes, id, 0);
			const before = await logSnapshot(nodes);
			const started = performance.now();
			const answers = await Promise.all(nodes.slice(0, contenders).map((node) => contend(node, id, HOT_KEY_MS)));
			const elapsedMs = performance.now() - started;
			const sections = answers.reduce((sum, answer) => sum + answer.sectionMs.length, 0);
			const failures = answers.reduce((sum, answer) => sum + answer.failures, 0);
			const after = await logSnapshotAfter(
				nodes,
				before,
				nodes.map((_, i) => (answers[i] ? answers[i].sectionMs.length + answers[i].failures : 0))
			);
			// Every critical section landed exactly once, on every node: the throughput is of correct handoffs.
			const converged = await waitForCounter(nodes, id, sections).then(
				() => true,
				(error) => error.message
			);
			const run = {
				contenders,
				durationMs: HOT_KEY_MS,
				sections,
				failures,
				sectionsPerSecond: Math.round((sections / elapsedMs) * 1000 * 10) / 10,
				converged,
				finalCounter: await Promise.all(nodes.map((node) => counter(node, id).then((record) => record?.n))),
				// Pooled over every contender's samples; the per-node distributions are kept beside them.
				lockMs: distribution(answers.flatMap((answer) => answer.lockMs)),
				sectionMs: distribution(answers.flatMap((answer) => answer.sectionMs)),
				requestMs: distribution(answers.flatMap((answer) => answer.requestMs)),
				perNode: answers.map((answer, i) => ({
					node: i,
					sections: answer.sectionMs.length,
					failures: answer.failures,
					lastN: answer.lastN,
					lockMs: distribution(answer.lockMs),
					sectionMs: distribution(answer.sectionMs),
					requestMs: distribution(answer.requestMs),
				})),
				// Per round started: a timed-out round wrote its request and withdraw too.
				log: logDelta(before, after, sections + failures),
			};
			results.hotKey.push(run);
			report(t, `hot key, ${contenders} contenders`, {
				sectionsPerSecond: run.sectionsPerSecond,
				sections,
				failures,
				converged,
				finalCounter: run.finalCounter,
				lockMs: run.lockMs,
				sectionMs: run.sectionMs,
				requestMs: run.requestMs,
			});
		}
		await save();
		for (const run of results.hotKey)
			assert.equal(run.converged, true, `${run.contenders} contenders: ${run.converged}`);
	});
});

suite('record lock cost: unlocked write throughput by enablement arm', { timeout: 900_000 }, (ctx) => {
	const arms = [
		{ name: 'off', replication: { recordLocks: false }, expectedProbe: /not enabled on this node/ },
		{ name: 'none', replication: { databases: ['system'] }, expectedProbe: /no record lock transport is registered/ },
		{ name: 'on', replication: { recordLocks: true }, expectedProbe: undefined },
	];
	let contexts = [];

	before(async () => {
		contexts = await startAll(
			ctx.name,
			arms.map((arm) => arm.replication)
		);
		for (const [i, arm] of arms.entries()) {
			arm.node = contexts[i].harper;
			// Prove the arm: what a cluster-scoped lock() answers is the observable for which path is wired.
			const probe = await call(arm.node, 'LockProbe/', { id: 'probe' });
			if (arm.expectedProbe)
				assert.match(probe.message ?? '', arm.expectedProbe, `${arm.name}: ${JSON.stringify(probe)}`);
			else assert.equal(probe.acquired, true, `${arm.name}: ${JSON.stringify(probe)}`);
			arm.probe = probe;
			await call(arm.node, 'BenchWrite/', { prefix: 'warm', count: WRITE_BATCH });
		}
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
		await save();
	});

	test('5. unlocked puts, one transaction each, arms interleaved round by round', async (t) => {
		const batches = Object.fromEntries(arms.map((arm) => [arm.name, []]));
		for (let round = 0; round < WRITE_ROUNDS; round++) {
			for (const arm of arms) {
				const { elapsedMs } = await call(arm.node, 'BenchWrite/', { prefix: `w-${round}`, count: WRITE_BATCH });
				batches[arm.name].push(elapsedMs);
			}
		}
		results.unlockedWrites = {
			batchSize: WRITE_BATCH,
			rounds: WRITE_ROUNDS,
			arms: Object.fromEntries(
				arms.map((arm) => {
					const batchMs = distribution(batches[arm.name]);
					return [
						arm.name,
						{
							probe: arm.probe,
							batchMs,
							putsPerSecond: {
								atP50: Math.round((WRITE_BATCH / batchMs.p50) * 1000),
								atP95: Math.round((WRITE_BATCH / batchMs.p95) * 1000),
							},
						},
					];
				})
			),
		};
		for (const arm of arms)
			report(
				t,
				`unlocked writes, arm ${arm.name} (ms per ${WRITE_BATCH} puts)`,
				results.unlockedWrites.arms[arm.name].batchMs
			);
		t.diagnostic(`results written to ${OUT}`);
	});
});
