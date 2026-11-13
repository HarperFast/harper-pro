// Shared setup for the node-drain suites: a two-shard cluster whose sharded `Drained` table places an id ending in
// an even digit on shard 0 and an odd one on shard 1 (the default map over `replication.shards: [0, 1]`), the
// node-drain fixture, and a send-pause injector armed per node through a file directory.
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
export const FIXTURE = join(import.meta.dirname, 'fixture-node-drain');
const PAUSE_INJECTOR = join(import.meta.dirname, 'replicationSendPauseInjector.mjs');
export const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

export function nodeOptions(context) {
	return {
		env: {
			HARPER_TEST_REPLICATION_PAUSE_DIR: context.pauseDir,
			// floors reach peers within a second, so a test does not wait out the 30 s production interval
			HARPER_TEST_ORIGIN_FLOOR_INTERVAL_MS: '500',
			...context.env,
		},
		config: {
			threads: { count: 1, preload: [PAUSE_INJECTOR] },
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, level: 'warn' },
			replication: {
				threads: 0,
				experimentalAttributeSlots: true,
				securePort: context.hostname + ':9933',
				shard: context.shard,
				shards: [0, 1],
				databases: '*',
			},
		},
	};
}

/** `schema` replaces the fixture's schema.graphql; `database` is the one whose sockets `meshed` waits for. */
export async function startShardedCluster(ctx, shards, { env, schema, database } = {}) {
	const contexts = [];
	for (const shard of shards) {
		const hostname = await getNextAvailableLoopbackAddress();
		const dataRootDir = await mkdtemp(
			join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
		);
		const pauseDir = await mkdtemp(join(tmpdir(), 'node-drain-pause-'));
		const context = { name: ctx.name, shard, hostname, pauseDir, env, harper: { hostname, dataRootDir } };
		contexts.push(context);
		await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true });
		if (schema) await writeFile(join(dataRootDir, 'components', basename(FIXTURE), 'schema.graphql'), schema);
		await startHarper(context, nodeOptions(context));
	}
	const [seed, ...peers] = contexts.map((context) => context.harper);
	const { operation_token: token } = await sendOperation(seed, {
		operation: 'create_authentication_tokens',
		authorization: seed.admin,
	});
	for (const peer of peers)
		await sendOperation(peer, {
			operation: 'add_node',
			hostname: seed.hostname,
			authorization: 'Bearer ' + token,
			rejectUnauthorized: false,
		});
	await meshed(contexts, undefined, database);
	return contexts;
}

/** For `data`, also waits for its sharding state to be available. */
export function meshed(contexts, description = 'every data socket connected', database = 'data') {
	const expected = contexts.length - 1;
	return waitForCondition(
		async (signal) => {
			const statuses = await Promise.all(
				contexts.map((context) =>
					sendOperation(context.harper, { operation: 'cluster_status' }, { signal }).catch(() => undefined)
				)
			);
			return statuses.every(
				(status) =>
					(database !== 'data' || status?.sharding?.data?.state === 'available') &&
					status.connections.filter((connection) =>
						connection.database_sockets.some((socket) => socket.database === database && socket.connected)
					).length >= expected
			);
		},
		{ timeoutMs: 180_000, description }
	);
}

export async function request(
	node,
	path,
	{ method = 'GET', body, headers, signal = AbortSignal.timeout(60_000) } = {}
) {
	const response = await fetch(`${node.httpURL}/${path}`, {
		method,
		headers: {
			'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
			'Content-Type': 'application/json',
			...headers,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal,
	});
	const text = await response.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = text;
	}
	return { status: response.status, data };
}

export async function put(node, id, { table = 'Drained', body = id, headers } = {}) {
	const response = await request(node, `${table}/${id}`, { method: 'PUT', body: { id, body }, headers });
	assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response));
	return response;
}

/** A write from the main thread (operations API): it never queues behind a request held open on an HTTP worker. */
export async function upsert(node, id, { database = 'data', table = 'Drained', replicatedConfirmation } = {}) {
	return sendOperation(node, {
		operation: 'upsert',
		database,
		table,
		records: [{ id, body: id }],
		...(replicatedConfirmation ? { replicatedConfirmation } : {}),
	});
}

/** `table` is a table of `data`, or `database.table`. */
export async function localEntries(node, table = 'Drained', signal) {
	const [database, tableName] = table.includes('.') ? table.split('.') : [undefined, table];
	const response = await request(node, `LocalEntries/?table=${tableName}${database ? `&database=${database}` : ''}`, {
		signal,
	});
	assert.equal(response.status, 200, JSON.stringify(response));
	return response.data;
}

export function waitForLocal(node, ids, table = 'Drained', timeoutMs = 60_000) {
	return waitForCondition(
		async (signal) => {
			const entries = await localEntries(node, table, signal);
			return ids.every((id) => entries.some((entry) => entry.id === id && entry.body === id)) && entries;
		},
		{ timeoutMs, description: `${node.hostname} to hold ${ids.join(', ')} in ${table}` }
	);
}

/**
 * Starts a held write on `context`'s node (its key reserved, its commit waiting) and returns the in-flight request
 * with its `release()`. Until released, send nothing else to that node's HTTP workers: it can queue behind the
 * open transaction (use the operations API, which runs on the main thread).
 */
export async function holdWrite(context, id, { database, table = 'Drained', headers } = {}) {
	const gate = join(context.pauseDir, `held-${id}`);
	const inFlight = request(context.harper, 'HeldWrite', {
		method: 'POST',
		body: { database, table, id, body: id, gate },
		headers,
		signal: AbortSignal.timeout(600_000),
	});
	inFlight.catch(() => {});
	await waitForCondition(() => existsSync(gate + '.reserved'), {
		timeoutMs: 20_000,
		pollMs: 25,
		description: `${id} to reserve its key on ${context.hostname}`,
	});
	return { inFlight, release: () => writeFile(gate + '.release', '') };
}

export async function pauseLink(fromContext, toContext) {
	await writeFile(join(fromContext.pauseDir, `pause-${toContext.hostname}`), '');
}

export async function resumeLink(fromContext, toContext) {
	await rm(join(fromContext.pauseDir, `pause-${toContext.hostname}`), { force: true });
}

/** The floor `node` has recorded for `origin` on its direct route from it, or null. */
export async function directFloor(node, origin, signal, database) {
	const response = await request(node, database ? `SeqRows/?database=${database}` : 'SeqRows', { signal });
	assert.equal(response.status, 200, JSON.stringify(response));
	const row = response.data.find((entry) => entry.route === origin);
	return row?.nodes.find((entry) => entry.origin === origin)?.closedFloor ?? null;
}
