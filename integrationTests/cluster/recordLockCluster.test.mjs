/**
 * Cluster-wide record locks over the replication stream (harper-pro#438, W9 Phase 1 of harper#483).
 *
 * What only real nodes can prove: that core's control entries ride the audit stream and are applied
 * behind the data they protect, so serialized lock()+increment across three nodes never loses an
 * update; that a crashed holder's lease lets a waiter on another node through; that a stale holder
 * is fenced by LWW; and that a peer without the `recordLocks` capability fails a cluster lock closed
 * while the gate keeps grants off its wire.
 *
 * Every node runs one http worker (`threads.count: 1`): a cluster-scoped lock() is served only by the
 * worker that coordinates the database, and a keep-alive client would otherwise pin itself to a worker
 * that answers 503 (see replication/DESIGN.md → Cluster record locks).
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { readNodePid, sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const FIXTURE = join(import.meta.dirname, 'fixture-record-locks');
const DB = 'data';
const CONVERGE_TIMEOUT_MS = 90_000;
// Core: a participant bounds an observed round at its own observation + max(leaseMs, waitMs) + 5 s skew.
const LOCK_LEASE_SKEW_MS = 5_000;

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
		env: { HARPER_NO_FLUSH_ON_EXIT: true, ...env },
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

async function controlEntries(node) {
	const response = await fetch(`${node.httpURL}/LockControlEntries/`, { headers: { Accept: 'application/json' } });
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
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
	});

	test("cluster_status reports each database's lock coordinator", async () => {
		for (const node of nodes) {
			const status = await clusterStatusOf(node);
			const locks = status.recordLocks?.[DB];
			assert.ok(locks, `${node.hostname} reports no recordLocks for ${DB}: ${JSON.stringify(status.recordLocks)}`);
			assert.equal(typeof locks.ownerThreadId, 'number', 'the single http worker coordinates the database');
			assert.equal(locks.held, 0);
			assert.equal(locks.pending, 0);
			assert.equal(locks.deferred, 0);
			assert.equal(locks.droppedOffOwner, 0, 'nothing is applied off the coordinating worker');
		}
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
		// Each increment saw every earlier one: the grant that let it in was applied after the holder's write.
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

	test('a lock is exclusive across nodes while held, and hands over on release', async () => {
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
		await call(nodes[2], 'LockRelease/', { token: after.body.token });
	});

	// Last: the crashed node stays down, and every later cluster lock waits for a grant it can never give.
	test('a holder that crashes releases its key to a waiter on another node once its lease has run out', async () => {
		const id = 'crash-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		const lease = 3_000;
		const timeout = 3_000;
		const held = await call(nodes[0], 'LockHold/', { id, lease, timeout });
		assert.equal(held.status, 200, JSON.stringify(held.body));
		// The waiter must have observed the holder's round: it granted it, so its own log holds the grant.
		await waitForCondition(
			async () => (await controlEntries(nodes[1])).some((entry) => entry.type === 'lockGrant' && entry.nodeId === 0),
			{ timeoutMs: 30_000, description: 'the waiter to have granted the holder' }
		);
		const pid = await readNodePid(nodes[0]);
		process.kill(pid, 'SIGKILL');
		const started = Date.now();
		const waiter = await call(nodes[1], 'LockHold/', { id, lease: 60_000, timeout: 60_000 });
		const waited = Date.now() - started;
		assert.equal(waiter.status, 200, `the waiter must acquire after the lease: ${JSON.stringify(waiter.body)}`);
		assert.ok(
			waited <= Math.max(lease, timeout) + LOCK_LEASE_SKEW_MS + 15_000,
			`acquired ${waited}ms after the crash; the bound is max(lease, timeout) + skew`
		);
		await call(nodes[1], 'LockRelease/', { token: waiter.body.token });
		// Documented Phase 1 limitation (harper#2498 requires a cluster-agreed DOWN before excluding a
		// peer, which harper-pro does not assert): with the crashed node still in hdb_nodes, a fresh
		// round waits for its grant and times out. Safe, not live.
		const stillDown = await call(nodes[2], 'LockHold/', { id, lease: 5_000, timeout: 1_500 });
		assert.equal(stillDown.status, 423, JSON.stringify(stillDown.body));
		const nodeScoped = await call(nodes[2], 'LockHold/', { id, scope: 'node', timeout: 1_500 });
		assert.equal(nodeScoped.status, 200, `a node-scoped lock still works: ${JSON.stringify(nodeScoped.body)}`);
		await call(nodes[2], 'LockRelease/', { token: nodeScoped.body.token });
	});
});

suite('cluster record locks: a peer without the recordLocks capability', { timeout: 300_000 }, (ctx) => {
	let currentCtx;
	let legacyCtx;
	let current;
	let legacy;

	before(async () => {
		// The "legacy" node is this build with its capability bag suppressed: it negotiates as a peer that
		// never advertised recordLocks while still running the lock machinery, which is exactly what makes
		// the send gate observable — a grant that does reach it lets its lock() succeed.
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

	test('the current node fails a cluster lock closed with 503 and still serves a node-scoped lock', async () => {
		const id = 'mixed-' + Date.now();
		const clusterScoped = await call(current, 'LockHold/', { id, timeout: 2_000 });
		assert.equal(clusterScoped.status, 503, JSON.stringify(clusterScoped.body));
		assert.match(JSON.stringify(clusterScoped.body), /does not support record locks/);
		assert.deepEqual(await controlEntries(current), [], 'a round that fails closed writes nothing to the log');
		const nodeScoped = await call(current, 'LockHold/', { id, scope: 'node', timeout: 2_000 });
		assert.equal(nodeScoped.status, 200, JSON.stringify(nodeScoped.body));
		await call(current, 'LockRelease/', { token: nodeScoped.body.token });
	});

	test('a grant for the bag-less peer is written but never sent, so its own round times out', async () => {
		const id = 'gated-' + Date.now();
		// The bag-less node sees the current node advertise recordLocks, so it runs a real round.
		const legacyRound = await call(legacy, 'LockHold/', { id, lease: 2_000, timeout: 2_000 });
		assert.equal(legacyRound.status, 423, `without the grant the round times out: ${JSON.stringify(legacyRound.body)}`);
		// The current node writes a grant (nodeId 0 = its own origin) in response to the peer's request,
		// which is itself proof the request arrived and was accepted by the coordinator. Received entries
		// are applied to the coordinator, not persisted in the receiver's log (no relay copy), so the
		// peer's request is deliberately absent from this node's log — the grant is the observable.
		await waitForCondition(
			async () => {
				const entries = await controlEntries(current);
				return entries.some((entry) => entry.type === 'lockGrant' && entry.nodeId === 0);
			},
			{ timeoutMs: 30_000, description: 'the current node to have written a grant for the bag-less peer' }
		);
		// Data still replicates both ways past the gated entries.
		await putCounter(legacy, id, 7);
		await waitForCounter([current, legacy], id, 7);
		await putCounter(current, id + '-back', 8);
		await waitForCounter([current, legacy], id + '-back', 8);
	});
});
