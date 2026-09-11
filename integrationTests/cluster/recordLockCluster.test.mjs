/**
 * Cluster-wide record locks over delegations (harper-pro#438, W9 Phase 1 of harper#483).
 *
 * What only real nodes can prove: that a delegation request reaches a key's home over the real
 * replication connections and comes back granted; that serialized lock()+increment across three
 * nodes never loses an update; that a key held on one node hands over to another on release,
 * through recall; that a lock is exclusive across nodes while held; that a stale holder is fenced;
 * and that a peer without the delegation-level `recordLocks` capability is not a ring member and
 * fails a cluster lock closed.
 *
 * Every node runs one http worker (`threads.count: 1`): a cluster-scoped lock() is served only by the
 * worker that coordinates the database, and a keep-alive client would otherwise pin itself to a worker
 * that answers 503 (see replication/DESIGN.md → Cluster record locks).
 *
 * The transport's epoch is STATIC in this tranche, and it is withheld for `RESTART_HOLD_MS` (the
 * delegation lease plus skew, six minutes) after process start — see the transport module comment.
 * `HARPER_TEST_RECORD_LOCK_RESTART_HOLD_MS=0` lifts that hold for tests; without it every cluster
 * lock in this file would fail closed for six minutes after the nodes start.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const FIXTURE = join(import.meta.dirname, 'fixture-record-locks');
const DB = 'data';
const CONVERGE_TIMEOUT_MS = 90_000;

function optionsFor(hostname, env = {}) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true, level: 'warn' },
			threads: { count: 1 },
			replication: {
				securePort: hostname + ':9933',
				databases: [DB, 'system'],
				recordLocks: true,
				pingInterval: 1000,
				pingTimeout: 3000,
			},
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_RECORD_LOCK_RESTART_HOLD_MS: '0', ...env },
	};
}

/** A node with the fixture pre-installed, bound to a pre-allocated address (see cacheReplicationSource). */
async function startNode(suiteName, env) {
	const hostname = await getNextAvailableLoopbackAddress();
	const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
	await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true, dereference: true });
	const ctx = { name: suiteName, harper: { hostname, dataRootDir } };
	await startHarper(ctx, optionsFor(hostname, env));
	return ctx;
}

async function stopNode(ctx) {
	if (!ctx?.harper) return;
	await stopNodeProcess(ctx.harper).catch(() => {});
	await teardownHarper(ctx).catch((error) => console.error(`teardown of ${ctx.harper.hostname} failed:`, error));
}

/** POST to a fixture endpoint; resolves { status, body } rather than throwing on a non-2xx answer. */
async function call(node, path, body, signal) {
	const response = await fetch(`${node.httpURL}/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify(body),
		signal,
	});
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = text;
	}
	return { status: response.status, body: parsed };
}

async function counter(node, id, signal) {
	const response = await fetch(`${node.httpURL}/Counter/${id}`, { headers: { Accept: 'application/json' }, signal });
	if (response.status === 404) return undefined;
	// Read the body once: an `await response.text()` inside the assert message is evaluated eagerly,
	// which consumes the body before a `.json()` on the success path could.
	const text = await response.text();
	assert.equal(response.status, 200, text);
	return JSON.parse(text);
}

async function putCounter(node, id, n) {
	const response = await fetch(`${node.httpURL}/Counter/${id}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ id, n }),
	});
	assert.ok(response.ok, await response.text());
}

async function controlEntries(node, signal) {
	const response = await fetch(`${node.httpURL}/LockControlEntries/`, {
		headers: { Accept: 'application/json' },
		signal,
	});
	const text = await response.text();
	assert.equal(response.status, 200, text);
	return JSON.parse(text);
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

async function clusterStatusOf(node, signal) {
	return sendOperation(node, { operation: 'cluster_status' }, { signal });
}

/** Every node sees every other node's `data` socket connected and has learned its capabilities. */
function waitForMesh(nodes) {
	return waitForCondition(
		async (signal) => {
			const statuses = await Promise.all(nodes.map((node) => clusterStatusOf(node, signal).catch(() => undefined)));
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

/** Every node's transport reports the full member set: the ring is agreed before any lock is taken. */
function waitForRing(nodes, expectedSize) {
	return waitForCondition(
		async (signal) => {
			const statuses = await Promise.all(nodes.map((node) => clusterStatusOf(node, signal).catch(() => undefined)));
			const members = statuses.map((status) => status?.recordLocks?.[DB]?.members);
			return members.every((list) => Array.isArray(list) && list.length === expectedSize) ? members : undefined;
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: `every node to see a ${expectedSize}-member ring` }
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

suite('cluster record locks: three-node full mesh', { timeout: 420_000 }, (ctx) => {
	const contexts = [];
	let nodes;

	before(async () => {
		// allSettled, not all: one failed start must not drop the contexts of the nodes that did come up,
		// or `after` sees an empty list and leaks their processes and ports into the rest of the run.
		const started = await Promise.allSettled([startNode(ctx.name), startNode(ctx.name), startNode(ctx.name)]);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		nodes = contexts.map((c) => c.harper);
		await connectMesh(nodes);
		await waitForRing(nodes, nodes.length);
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
	});

	test("cluster_status reports each database's lock coordinator and the agreed ring", async () => {
		const rings = [];
		for (const node of nodes) {
			const status = await clusterStatusOf(node);
			const locks = status.recordLocks?.[DB];
			assert.ok(locks, `${node.hostname} reports no recordLocks for ${DB}: ${JSON.stringify(status.recordLocks)}`);
			assert.equal(typeof locks.ownerThreadId, 'number', 'the single http worker coordinates the database');
			assert.equal(locks.granted, 0);
			assert.equal(locks.admitted, 0);
			assert.equal(locks.droppedOffOwner, 0, 'nothing is applied off the coordinating worker');
			rings.push(JSON.stringify(locks.members));
		}
		// The whole point of deriving the home from an agreed set: every node computes the same ring.
		assert.equal(new Set(rings).size, 1, `nodes disagree about the ring: ${rings.join(' | ')}`);
	});

	test('N concurrent lock()+increment spread across the nodes lands exactly N on every node', async () => {
		const id = 'counter-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		const N = 24;
		const results = await Promise.all(
			Array.from({ length: N }, (_, i) => call(nodes[i % nodes.length], 'LockedIncrement/', { id }))
		);
		const failed = results.filter((result) => result.status !== 200);
		assert.deepEqual(failed, [], `every increment must succeed: ${JSON.stringify(failed)}`);
		// Each increment saw every earlier one: the release that let its delegation in was applied after
		// the previous holder's write on that holder's own stream.
		const seen = results.map((result) => result.body.n).sort((a, b) => a - b);
		assert.deepEqual(
			seen,
			Array.from({ length: N }, (_, i) => i + 1)
		);
		assert.deepEqual(
			await waitForCounter(nodes, id, N),
			nodes.map(() => N)
		);
	});

	test('repeat locks from one node cost no release entries: the delegation is retained', async () => {
		const id = 'repeat-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		const before = (await controlEntries(nodes[0])).length;
		for (let i = 0; i < 10; i++) {
			const result = await call(nodes[0], 'LockedIncrement/', { id });
			assert.equal(result.status, 200, JSON.stringify(result.body));
		}
		await delay(500);
		// Releasing the application lock does not release the delegation, so ten locks on one node write
		// nothing to the log; a release entry appears only when another node takes the key.
		assert.equal((await controlEntries(nodes[0])).length, before, 'no release per repeat lock');
		await waitForCounter(nodes, id, 10);
	});

	test("a plain write during a hold wins by LWW over the holder's write, and a write after the lease is 409", async () => {
		const id = 'fence-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		const lease = 2_000;
		const held = await call(nodes[0], 'LockHold/', { id, lease, timeout: 5_000 });
		assert.equal(held.status, 200, JSON.stringify(held.body));
		const { token } = held.body;
		// Plain writes are never gated: this lands immediately, stamped now, later than the holder's tsR.
		await putCounter(nodes[1], id, 100);
		const written = await call(nodes[0], 'LockWrite/', { token, n: 1 });
		assert.equal(written.status, 200, JSON.stringify(written.body));
		assert.deepEqual(
			await waitForCounter(nodes, id, 100),
			nodes.map(() => 100)
		);
		await delay(lease + 500);
		const stale = await call(nodes[0], 'LockWrite/', { token, n: 2 });
		assert.equal(stale.status, 409, `a write after the lease must be refused: ${JSON.stringify(stale.body)}`);
		assert.deepEqual(
			await waitForCounter(nodes, id, 100),
			nodes.map(() => 100)
		);
		await call(nodes[0], 'LockRelease/', { token });
	});

	test('a lock is exclusive across nodes while held, and hands over through recall on release', async () => {
		const id = 'exclusive-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		const held = await call(nodes[0], 'LockHold/', { id, lease: 20_000, timeout: 5_000 });
		assert.equal(held.status, 200, JSON.stringify(held.body));
		const contended = await call(nodes[1], 'LockHold/', { id, lease: 5_000, timeout: 1_500 });
		assert.equal(contended.status, 423, `a second node must wait, then time out: ${JSON.stringify(contended.body)}`);
		await call(nodes[0], 'LockRelease/', { token: held.body.token });
		const after = await call(nodes[2], 'LockHold/', { id, lease: 5_000, timeout: 10_000 });
		assert.equal(after.status, 200, `after release a third node acquires: ${JSON.stringify(after.body)}`);
		// The handoff is what writes a release: the recalled delegate surrenders on the replicated log.
		await waitForCondition(
			async (signal) =>
				(await controlEntries(nodes[0], signal)).some((entry) => entry.type === 'lockRelease' && entry.nodeId === 0),
			{ timeoutMs: 30_000, description: 'the recalled node to have written its release' }
		);
		await call(nodes[2], 'LockRelease/', { token: after.body.token });
	});

	// A crashed delegate holds its keys for up to DELEGATION_LEASE_MS (six minutes) before its home
	// re-grants them, which does not fit a test; whether that lease is configurable is an open
	// question on harper#2498. The property itself — a home never re-grants before the delegate's
	// deadline plus skew, on independent clocks — is asserted in core's coordinator unit suite.
	test.skip('a holder that crashes releases its key to a waiter once its delegation has run out', () => {});
});

suite('cluster record locks: a peer without the recordLocks capability', { timeout: 300_000 }, (ctx) => {
	let currentCtx;
	let legacyCtx;
	let current;
	let legacy;

	before(async () => {
		// The "legacy" node is this build with its capability bag suppressed: it negotiates as a peer that
		// never advertised recordLocks while still running the lock machinery.
		// allSettled so a single failed start does not orphan the node that did come up.
		const started = await Promise.allSettled([
			startNode(ctx.name),
			startNode(ctx.name, { HARPER_TEST_OMIT_REPLICATION_CAPABILITIES: '1' }),
		]);
		[currentCtx, legacyCtx] = started.map((result) => (result.status === 'fulfilled' ? result.value : undefined));
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		current = currentCtx.harper;
		legacy = legacyCtx.harper;
		await connectMesh([current, legacy]);
	});

	after(async () => {
		await stopNode(currentCtx);
		await stopNode(legacyCtx);
	});

	test('the bag-less peer is not a ring member, so the current node homes every key itself', async () => {
		const status = await clusterStatusOf(current);
		const members = status.recordLocks?.[DB]?.members;
		assert.ok(
			Array.isArray(members) && members.length === 1,
			`ring should be this node alone: ${JSON.stringify(members)}`
		);
		// And so a cluster lock here is served with no request to the peer at all.
		const id = 'mixed-' + Date.now();
		const clusterScoped = await call(current, 'LockHold/', { id, timeout: 2_000 });
		assert.equal(clusterScoped.status, 200, JSON.stringify(clusterScoped.body));
		await call(current, 'LockRelease/', { token: clusterScoped.body.token });
		assert.deepEqual(await controlEntries(current), [], 'a retained delegation writes nothing to the log');
	});

	test('the bag-less peer fails its own cluster lock closed and data still replicates both ways', async () => {
		const id = 'gated-' + Date.now();
		// It advertised nothing, so every peer excludes it from their ring — and its own transport
		// withholds its epoch for the same reason, rather than building a ring that includes itself and
		// self-homing keys its peers home elsewhere. Fail closed, not a quiet second arbiter.
		const legacyLock = await call(legacy, 'LockHold/', { id, lease: 2_000, timeout: 2_000 });
		assert.equal(
			legacyLock.status,
			503,
			`a bag-less node must fail a cluster lock closed: ${JSON.stringify(legacyLock.body)}`
		);
		await putCounter(legacy, id, 7);
		await waitForCounter([current, legacy], id, 7);
		await putCounter(current, id + '-back', 8);
		await waitForCounter([current, legacy], id + '-back', 8);
	});
});
