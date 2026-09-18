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
 * 2. Repeat-lock latency: one node, one key, over and over. The first lock is reported apart from
 *    the repeats, and on a key this node homes as well as one it does not, because the delegation
 *    protocol pays a round only on the first and only when the home is elsewhere.
 * 3. Hot-key handoff throughput: 2 then 3 nodes contending on one key, one lock → increment → unlock
 *    request in flight per node (the request transaction's commit is the unlock). Lock and section
 *    times are the node's own; the request round trip is the client's view. Every section's written
 *    value is audited and the counter is expected to reach the section count — a handoff now carries
 *    successor freshness (harper#2613, the `lockBarrier` fence) as well as exclusion — but this is a
 *    measurement, so a shortfall is recorded rather than asserted.
 * 4. Transaction-log cost per acquisition: control entries and value bytes per node, from the log.
 * 5. Cost when off: unlocked write throughput with recordLocks off, with no transport registered at
 *    all (the database is not replicated), and with it on but unused.
 * 6. Re-acquisition rate: how often an uncontended repeat lock still pays a cluster round because
 *    its delegation lapsed, at two candidate lock leases.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { basename, join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';
import { bootstrapHomeMap, waitForRing } from './recordLockShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const FIXTURE = join(import.meta.dirname, 'fixture-record-lock-bench');
const DB = 'data';
const CONVERGE_TIMEOUT_MS = 90_000;

const UNCONTENDED_PER_NODE = 120;
const REPEAT_ACQUISITIONS = 200;
const HOT_KEY_MS = Number(process.env.RECORD_LOCK_BENCH_HOT_KEY_MS) || 15_000;
const WRITE_BATCH = 500;
const WRITE_ROUNDS = 30;
/**
 * Mirrors core's DELEGATION_LEASE_MS, which has no override. A lock asking for `lease` is served
 * from a live delegation only while that much of it is left, so the local-serve window measurement 6
 * sizes its runs against is DELEGATION_LEASE_MS - lease.
 */
const DELEGATION_LEASE_MS = 360_000;
const REACQUISITION_LEASES_MS = process.env.RECORD_LOCK_BENCH_REACQ_LEASES_MS
	? process.env.RECORD_LOCK_BENCH_REACQ_LEASES_MS.split(',').map(Number)
	: [300_000, 240_000];
const REACQUISITION_CADENCE_MS = Number(process.env.RECORD_LOCK_BENCH_REACQ_CADENCE_MS) || 5_000;
const REACQUISITION_MAX_RUN_MS = Number(process.env.RECORD_LOCK_BENCH_REACQ_RUN_MS) || 260_000;
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
		// Grants are withheld for several minutes after start; a freshly started bench node has no
		// previous incarnation to protect, so lift the hold as the cluster suite does. The drain
		// backstop goes with it: `bootstrapHomeMap` stages and activates back to back, which is safe
		// only because nothing has ever been delegated on a node this new.
		env: {
			HARPER_NO_FLUSH_ON_EXIT: true,
			HARPER_TEST_RECORD_LOCK_RESTART_HOLD_MS: '0',
			HARPER_TEST_RECORD_LOCK_MIN_DRAIN_BACKSTOP_MS: '0',
		},
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

// A settled snapshot (three agreeing polls), not a durability proof; writtenValueAudit is the source
// of truth for the document's numeric claims.
function waitForAgreedCounter(nodes, id) {
	let previous;
	let stablePolls = 0;
	return waitForCondition(
		async (signal) => {
			const values = await Promise.all(nodes.map((node) => counter(node, id, signal).then((record) => record?.n)));
			const agreed = values.every((n) => n === values[0]) ? values[0] : undefined;
			stablePolls = agreed !== undefined && agreed === previous ? stablePolls + 1 : 0;
			previous = agreed;
			// Wrapped: a cluster that settles on 0 is an answer, and waitForCondition discards a falsy one.
			return stablePolls >= 2 ? { agreed } : undefined;
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, pollMs: 250, description: `Counter/${id} to settle on one value everywhere` }
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
	const written = [];
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
		written.push(body.n);
		lastN = body.n;
	}
	return { requestMs, sectionMs, lockMs, failures, lastN, written };
}

/**
 * Every admitted section reads n and writes n+1, so across all contenders the written values must be
 * exactly 1..sections with nothing repeated. A repeat is two sections that read the same value: a
 * lost update, and an exclusion or freshness failure. A hole with no repeat is the opposite — every
 * section read a distinct value and a committed write did not survive.
 */
function writtenValueAudit(answers, finalCounter) {
	// Per value, every node that has written it — a same-node repeat is not a cross-node duplicate.
	const seen = new Map();
	const repeated = [];
	for (const [node, answer] of answers.entries())
		for (const n of answer.written) {
			let writers = seen.get(n);
			if (writers === undefined) seen.set(n, (writers = new Set()));
			if (writers.size > 0)
				repeated.push({ n, nodes: [writers.values().next().value, node], sameNode: writers.has(node) });
			writers.add(node);
		}
	const total = answers.reduce((sum, answer) => sum + answer.written.length, 0);
	// Not Math.max(...keys): a 40 s round writes 61k distinct values, past V8's argument limit.
	let maxWritten = 0;
	for (const n of seen.keys()) if (n > maxWritten) maxWritten = n;
	// Only below maxWritten — values above it were never reached, because a repeat consumed them.
	const holes = [];
	for (let n = 1; n <= maxWritten && holes.length < 20; n++) if (!seen.has(n)) holes.push(n);
	const acrossNodes = repeated.filter((entry) => !entry.sameNode).length;
	return {
		distinctValues: seen.size,
		sections: total,
		repeatedCount: repeated.length,
		repeatedAcrossNodes: acrossNodes,
		repeatedValues: repeated.slice(0, 20),
		holes,
		maxWritten,
		finalCounter,
	};
}

function percentile(sorted, p) {
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function distribution(samples) {
	if (samples.length === 0) return { n: 0 };
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
 * Each node's coordinator gauges. `delegations` is what a process-wide cap (harper#2581) would have
 * to hold: a delegation is retained after unlock, so this counts distinct keys this node has locked
 * and not yet had recalled, not locks in flight.
 */
async function lockStats(nodes, signal) {
	return Promise.all(nodes.map((node) => call(node, 'LockStats/', undefined, signal)));
}

/**
 * unlock() returns before any release entry is durable, so a snapshot taken straight after a batch
 * can carry entries into the next window. The Ricart-Agrawala baseline waited for one release per
 * round started; a delegation writes a release only when the key actually changes hands, and an
 * uncontended repeat writes nothing at all, so that boundary never arrives here. The
 * protocol-agnostic one is the log going quiet: three consecutive polls that add nothing.
 */
async function logSnapshotAfter(nodes) {
	const totals = (snapshot) =>
		snapshot.map((byType) => LOCK_ENTRY_TYPES.reduce((sum, type) => sum + (byType[type]?.entries ?? 0), 0));
	let previous = totals(await logSnapshot(nodes));
	let quietPolls = 0;
	return waitForCondition(
		async (signal) => {
			const after = await logSnapshot(nodes, signal);
			const counts = totals(after);
			quietPolls = counts.every((count, i) => count === previous[i]) ? quietPolls + 1 : 0;
			previous = counts;
			return quietPolls >= 3 ? after : undefined;
		},
		// LogStats rescans the whole audit store per poll, which after a long hot-key round is 60k+
		// entries on every node; polling slower keeps the detector from perturbing what it waits for.
		{ timeoutMs: 30_000, pollMs: 500, description: 'the control-entry log to go quiet' }
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

/**
 * Lock fresh ids from `node` until every side of the ring in `wanted` has one, keeping the answer:
 * the probe IS that key's first lock, so a later batch on the same id measures only repeats.
 * Candidates that land on a side already filled are simply left with a delegation of their own,
 * which costs nothing.
 */
async function probeKeys(node, prefix, wanted, options) {
	const found = {};
	for (let attempt = 0; attempt < 40 && !wanted.every((side) => found[side]); attempt++) {
		const id = `${prefix}-${attempt}-${Date.now()}`;
		const first = await call(node, 'BenchLock/', { ...options, ids: [id], classifyHome: true });
		found[first.homeLocal[0] ? 'local' : 'remote'] ??= { id, first };
	}
	for (const side of wanted) assert.ok(found[side], `${prefix}: no ${side}-home key found`);
	return found;
}

function splitByHome(acquireMs, homeLocal) {
	const local = acquireMs.filter((_, i) => homeLocal[i]);
	const remote = acquireMs.filter((_, i) => !homeLocal[i]);
	return {
		homeLocal: local.length ? distribution(local) : undefined,
		remoteHome: remote.length ? distribution(remote) : undefined,
	};
}

/**
 * Which ticks paid a cluster round.
 *
 * Every tick locks three times: a separate always-delegated key to absorb the ~0.1-0.25 ms a request
 * pays for its first lock whatever it does, then the measured key, then the measured key AGAIN. The
 * third lock cannot have lapsed — the second either renewed the delegation or found it live — so it
 * is a local serve taken in the same request, on the same key, microseconds apart, and the
 * difference between the two is what the second lock did beyond serving locally.
 */
function classifyRounds(samples, thresholdMs) {
	return { thresholdMs, rounds: samples.filter((sample) => sample.deltaMs >= thresholdMs) };
}

function report(t, title, value) {
	t.diagnostic(`${title}: ${JSON.stringify(value)}`);
}

async function save() {
	await writeFile(OUT, JSON.stringify(results, null, 2) + '\n');
}

suite('record lock cost: 3-node full mesh, replication.recordLocks on', { timeout: 2_400_000 }, (ctx) => {
	let contexts = [];
	let nodes;

	before(async () => {
		contexts = await startAll(ctx.name, [{ recordLocks: true }, { recordLocks: true }, { recordLocks: true }]);
		nodes = contexts.map((c) => c.harper);
		await connectMesh(nodes);
		// The home map is operator-stated, never derived (harper-pro#825): without this every
		// `BenchLock` below answers 503 and there is nothing to measure.
		await bootstrapHomeMap(nodes);
		await waitForRing(nodes, nodes.length);
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
		const pooledHomeLocal = [];
		for (const [i, node] of nodes.entries()) {
			const ids = Array.from({ length: UNCONTENDED_PER_NODE }, (_, k) => `uncontended-${i}-${k}-${Date.now()}`);
			const before = await logSnapshot(nodes);
			const { acquireMs, releaseMs, homeLocal } = await call(node, 'BenchLock/', { ids, classifyHome: true });
			const after = await logSnapshotAfter(nodes);
			pooledAcquire.push(...acquireMs);
			pooledRelease.push(...releaseMs);
			pooledHomeLocal.push(...homeLocal);
			perNode.push({
				requester: i,
				homeLocalKeys: homeLocal.filter(Boolean).length,
				acquire: distribution(acquireMs),
				byHome: splitByHome(acquireMs, homeLocal),
				release: distribution(releaseMs),
				log: logDelta(before, after, ids.length),
			});
		}
		results.uncontended = {
			perNode,
			acquire: distribution(pooledAcquire),
			byHome: splitByHome(pooledAcquire, pooledHomeLocal),
			release: distribution(pooledRelease),
		};
		results.uncontended.lockStats = await lockStats(nodes);
		report(t, 'uncontended acquire ms (pooled)', results.uncontended.acquire);
		report(t, 'coordinator gauges after 3 x 120 distinct keys', results.uncontended.lockStats);
		report(t, 'uncontended acquire ms by home (pooled)', results.uncontended.byHome);
		report(t, 'uncontended release ms (pooled)', results.uncontended.release);
		for (const entry of perNode) report(t, `log cost per acquisition, requester ${entry.requester}`, entry.log);
	});

	test('2+4. repeat-lock: one node, the same key, back to back, first lock reported apart', async (t) => {
		const before = await logSnapshot(nodes);
		const probed = await probeKeys(nodes[0], 'repeat-' + Date.now(), ['local', 'remote']);
		results.repeat = { requester: 0, byHome: {} };
		for (const side of ['local', 'remote']) {
			const { id, first } = probed[side];
			const ids = Array.from({ length: REPEAT_ACQUISITIONS }, () => id);
			const { acquireMs, releaseMs } = await call(nodes[0], 'BenchLock/', { ids });
			results.repeat.byHome[side] = {
				id,
				firstLockMs: Math.round(first.acquireMs[0] * 100) / 100,
				repeat: distribution(acquireMs),
				release: distribution(releaseMs),
			};
		}
		// Every acquisition in this test: both first locks, every probe that landed on the wrong side,
		// and 2 x REPEAT_ACQUISITIONS repeats.
		const after = await logSnapshotAfter(nodes);
		results.repeat.log = logDelta(before, after, 2 * REPEAT_ACQUISITIONS);
		results.repeat.lockStats = await lockStats(nodes);
		report(t, 'repeat-lock by home', results.repeat.byHome);
		report(t, 'repeat-lock log cost per repeat', results.repeat.log);
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
			const after = await logSnapshotAfter(nodes);
			// Recorded, not asserted: a handoff now carries successor freshness as well as exclusion
			// (harper#2613's `lockBarrier` fence, established before core admits), so this should equal
			// the section count — but this file is a measurement and `recordLockCluster.test.mjs` is the
			// gate that asserts it. Nodes that never agree are a result to record, not a reason to abort
			// the remaining rounds.
			const agreed = await waitForAgreedCounter(nodes, id).then(
				(settled) => settled.agreed,
				() => undefined
			);
			const finalCounter = await Promise.all(nodes.map((node) => counter(node, id).then((record) => record?.n)));
			const run = {
				contenders,
				durationMs: HOT_KEY_MS,
				sections,
				failures,
				sectionsPerSecond: Math.round((sections / elapsedMs) * 1000 * 10) / 10,
				agreedCounter: agreed,
				converged: agreed === sections,
				lostUpdates: agreed === undefined ? undefined : sections - agreed,
				finalCounter,
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
				// Per round started. A delegation writes nothing per round; the entries counted here are
				// the releases its handoffs wrote, which is the point of the ratio.
				log: logDelta(before, after, sections + failures),
				lockStats: await lockStats(nodes),
				audit: writtenValueAudit(answers, finalCounter),
			};
			results.hotKey.push(run);
			report(t, `hot key, ${contenders} contenders`, {
				sectionsPerSecond: run.sectionsPerSecond,
				sections,
				failures,
				agreedCounter: run.agreedCounter,
				lostUpdates: run.lostUpdates,
				sectionsPerNode: run.perNode.map((entry) => entry.sections),
				audit: {
					distinctValues: run.audit.distinctValues,
					repeatedCount: run.audit.repeatedCount,
					repeatedValues: run.audit.repeatedValues,
					holes: run.audit.holes,
					maxWritten: run.audit.maxWritten,
				},
				finalCounter: run.finalCounter,
				lockMs: run.lockMs,
				sectionMs: run.sectionMs,
				requestMs: run.requestMs,
			});
		}
		await save();
	});

	test('6. re-acquisition rate when a delegation lapses without contention', async (t) => {
		results.reacquisition = [];
		for (const lease of REACQUISITION_LEASES_MS) {
			// A lock asking for `lease` keeps being served locally until the delegation has less than
			// that left, so this is the window the cadence is measured against.
			const windowMs = DELEGATION_LEASE_MS - lease;
			const runMs = Math.min(windowMs * 3, REACQUISITION_MAX_RUN_MS);
			// Homed elsewhere: a re-acquisition to a local home is a function call, which no latency cut
			// separates from a delegated serve.
			const { remote: target } = await probeKeys(nodes[0], `reacq-${lease}-${Date.now()}`, ['remote'], { lease });
			// Default lease, so its own delegation outlives the run rather than lapsing mid-measurement.
			const warmupId = `reacq-warm-${lease}-${Date.now()}`;
			await call(nodes[0], 'BenchLock/', { ids: [warmupId] });
			const startedAtMs = target.first.atMs[0];
			const samples = [];
			for (;;) {
				await delay(REACQUISITION_CADENCE_MS);
				const answer = await call(nodes[0], 'BenchLock/', { ids: [target.id, target.id], lease, warmupId });
				const elapsedMs = answer.atMs[0] - startedAtMs;
				samples.push({
					elapsedMs: Math.round(elapsedMs),
					acquireMs: answer.acquireMs[0],
					servedLocallyMs: answer.acquireMs[1],
					deltaMs: Math.round((answer.acquireMs[0] - answer.acquireMs[1]) * 1000) / 1000,
				});
				if (elapsedMs >= runMs) break;
			}
			// The cheapest single cluster round measurement 1 saw, in this run, on this box. Absent only if
			// no key in measurement 1 was homed elsewhere, which leaves nothing to calibrate against.
			// Absolute latency compared against a delta below; undercounts borderline rounds as served
			// locally (§6 of the results document).
			const remoteHome = results.uncontended.byHome.remoteHome;
			assert.ok(remoteHome, 'measurement 1 saw no remote-home key; cannot calibrate a cluster round');
			const thresholdMs = remoteHome.min;
			const { rounds } = classifyRounds(samples, thresholdMs);
			const servedLocally = samples.filter((sample) => sample.deltaMs < thresholdMs);
			// Independent of the cut: the third lock of every tick, lapsed or not.
			const localReference = distribution(samples.map((sample) => sample.servedLocallyMs));
			// A prediction test, not the rate: a lapse should fall on a multiple of the window.
			const atWindowMultiple = rounds.filter((sample) => {
				// Distance to the NEAREST multiple: a lapse landing just before one leaves a remainder of
				// nearly windowMs, which reads as far from a boundary rather than adjacent to it.
				const remainder = sample.elapsedMs % windowMs;
				return Math.min(remainder, windowMs - remainder) < REACQUISITION_CADENCE_MS * 1.5;
			}).length;
			// DELEGATION_LEASE_MS is copied from core; if it is retuned there, lapses stop landing on
			// multiples of the window computed here and every rate below is against a stale prediction.
			const windowLooksStale = rounds.length > 0 && atWindowMultiple === 0;
			const run = {
				lease,
				windowMs,
				cadenceMs: REACQUISITION_CADENCE_MS,
				runMs: Math.round(samples[samples.length - 1].elapsedMs),
				firstLockMs: Math.round(target.first.acquireMs[0] * 100) / 100,
				ticks: samples.length,
				reacquisitions: rounds.length,
				measuredRate: Math.round((rounds.length / samples.length) * 10000) / 10000,
				predictedRate: Math.round((REACQUISITION_CADENCE_MS / windowMs) * 10000) / 10000,
				reacquiredAtMs: rounds.map((sample) => sample.elapsedMs),
				thresholdMs: Math.round(thresholdMs * 1000) / 1000,
				atWindowMultiple,
				windowLooksStale,
				localReferenceMs: localReference,
				servedLocallyDeltaMs: servedLocally.length ? distribution(servedLocally.map((s) => s.deltaMs)) : undefined,
				reacquiredDeltaMs: rounds.length ? distribution(rounds.map((s) => s.deltaMs)) : undefined,
				samples,
			};
			results.reacquisition.push(run);
			report(t, `re-acquisition at lease ${lease} ms (window ${windowMs} ms)`, {
				ticks: run.ticks,
				reacquisitions: run.reacquisitions,
				measuredRate: run.measuredRate,
				predictedRate: run.predictedRate,
				reacquiredAtMs: run.reacquiredAtMs,
				thresholdMs: run.thresholdMs,
				atWindowMultiple: run.atWindowMultiple,
				windowLooksStale: run.windowLooksStale,
				localReferenceMs: run.localReferenceMs,
				servedLocallyDeltaMs: run.servedLocallyDeltaMs,
				reacquiredDeltaMs: run.reacquiredDeltaMs,
			});
			await save();
		}
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
			// Only the enabled arm has a transport that asks for a home map, and a lone node's ring is
			// itself; the other two arms must answer their refusal without one.
			if (arm.name === 'on') {
				await bootstrapHomeMap([arm.node]);
				await waitForRing([arm.node], 1);
			}
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
