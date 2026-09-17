/**
 * Fixture, node lifecycle and operator helpers shared by the cluster record-lock suites
 * (`recordLockCluster.test.mjs`, `recordLockApplyHomes.test.mjs`). See the header of the former for
 * what these suites prove and why every node runs one http worker.
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const FIXTURE = join(import.meta.dirname, 'fixture-record-locks');
export const DB = 'data';
export const CONVERGE_TIMEOUT_MS = 90_000;
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
		env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_RECORD_LOCK_MIN_DRAIN_BACKSTOP_MS: '0', ...env },
	};
}

/** A node with the fixture pre-installed, bound to a pre-allocated address (see cacheReplicationSource). */
export async function startNode(suiteName, env) {
	const hostname = await getNextAvailableLoopbackAddress();
	const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
	await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true, dereference: true });
	const ctx = { name: suiteName, harper: { hostname, dataRootDir } };
	await startHarper(ctx, optionsFor(hostname, env));
	return ctx;
}

export async function stopNode(ctx) {
	if (!ctx?.harper) return;
	await stopNodeProcess(ctx.harper).catch(() => {});
	await teardownHarper(ctx).catch((error) => console.error(`teardown of ${ctx.harper.hostname} failed:`, error));
}

/** POST to a fixture endpoint; resolves { status, body } rather than throwing on a non-2xx answer. */
export async function call(node, path, body, signal) {
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

export async function counter(node, id, signal) {
	const response = await fetch(`${node.httpURL}/Counter/${id}`, { headers: { Accept: 'application/json' }, signal });
	if (response.status === 404) return undefined;
	// Read the body once: an `await response.text()` inside the assert message is evaluated eagerly,
	// which consumes the body before a `.json()` on the success path could.
	const text = await response.text();
	assert.equal(response.status, 200, text);
	return JSON.parse(text);
}

export async function putCounter(node, id, n) {
	const response = await fetch(`${node.httpURL}/Counter/${id}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ id, n }),
	});
	assert.ok(response.ok, await response.text());
}

export async function controlEntries(node, signal) {
	const response = await fetch(`${node.httpURL}/LockControlEntries/`, {
		headers: { Accept: 'application/json' },
		signal,
	});
	const text = await response.text();
	assert.equal(response.status, 200, text);
	return JSON.parse(text);
}

export function waitForCounter(nodes, id, expected) {
	return waitForCondition(
		async (signal) => {
			const values = await Promise.all(nodes.map((node) => counter(node, id, signal).then((record) => record?.n)));
			return values.every((n) => n === expected) ? values : undefined;
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: `Counter/${id} to read ${expected} on every node` }
	);
}

export async function clusterStatusOf(node, signal) {
	return sendOperation(node, { operation: 'cluster_status' }, { signal });
}

/** Every node sees every other node's `data` socket connected and has learned its capabilities. */
export function waitForMesh(nodes) {
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
export function waitForRing(nodes, expectedSize) {
	return waitForCondition(
		async (signal) => {
			const statuses = await Promise.all(nodes.map((node) => clusterStatusOf(node, signal).catch(() => undefined)));
			const members = statuses.map((status) => status?.recordLocks?.[DB]?.members);
			return members.every((list) => Array.isArray(list) && list.length === expectedSize) ? members : undefined;
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: `every node to see a ${expectedSize}-member ring` }
	);
}

/**
 * The operator's side of harper-pro#825's §4.3 transition: stage generation 1 (naming every node) on
 * every node, then activate it on every node. Nothing in the code enforces the real drain wait between
 * the two — `HARPER_TEST_RECORD_LOCK_MIN_DRAIN_BACKSTOP_MS=0` (set in `optionsFor`) disables even the
 * small backstop, so this bootstraps immediately; that is safe here specifically because every node is
 * freshly started with no prior generation, not something a real reconfiguration could skip.
 */
export async function bootstrapHomeMap(nodes) {
	const homes = [];
	for (const node of nodes) {
		const status = await clusterStatusOf(node);
		homes.push(status.node_name);
	}
	for (const node of nodes)
		await sendOperation(node, {
			operation: 'record_lock_stage_generation',
			database: DB,
			generation: 1,
			homes,
			authorization: node.admin,
		});
	for (const node of nodes)
		await sendOperation(node, {
			operation: 'record_lock_activate_generation',
			database: DB,
			generation: 1,
			homes,
			authorization: node.admin,
		});
	return homes;
}

export async function connectMesh(nodes) {
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

// ---- record_lock_apply_homes helpers (harper-pro#862) ----

/** POST an operation; resolves { status, body } so a refusal's body can be inspected. */
export async function operation(node, body) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...body, authorization: node.admin }),
	});
	return { status: response.status, body: await response.json() };
}

export function apply(node, fields) {
	return sendOperation(node, {
		operation: 'record_lock_apply_homes',
		database: DB,
		...fields,
		authorization: node.admin,
	});
}

/** A cluster lock on `node`: 200 while it serves an active generation, 503 while staged or excluded. */
export async function lockStatus(node, id) {
	const held = await call(node, 'LockHold/', { id, lease: 2_000, timeout: 2_000 });
	if (held.status === 200) await call(node, 'LockRelease/', { token: held.body.token });
	return held.status;
}

export async function assertLocks(nodes, expected, why) {
	const id = 'apply-' + Date.now();
	for (const node of nodes) assert.equal(await lockStatus(node, id), expected, `${node.hostname}: ${why}`);
}

export async function nodeNames(nodes) {
	const names = [];
	for (const node of nodes) names.push((await clusterStatusOf(node)).node_name);
	return names;
}

/** Every node's coordinating thread can prove a drain: core's `unprovenOwnershipMs` has run down. */
export function waitForProvableDrain(nodes) {
	return waitForCondition(
		async (signal) => {
			const statuses = await Promise.all(nodes.map((node) => clusterStatusOf(node, signal)));
			return statuses.every((status) => status.recordLocks?.[DB]?.unprovenMs === 0) ? statuses : undefined;
		},
		{ timeoutMs: 420_000, pollMs: 5_000, description: 'every node to be able to prove a drain' }
	);
}
