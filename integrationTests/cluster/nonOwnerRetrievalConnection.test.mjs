/**
 * harper-pro#1189: a non-owner read of a sharded table on an HTTP worker opens that worker's retrieval
 * connection to the owner. The replication pool is on, so the HTTP worker holds no subscriptions and the
 * read is the first thing on it to open a replication connection. Authentication is not local-implied, so
 * the read below is anonymous; the resource allows it.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { basename, join } from 'node:path';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { readLog, readNodePid, stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const FIXTURE = join(import.meta.dirname, 'fixture-non-owner-retrieval');
const PING_TIMEOUT = 3000;

const basic = (node) => 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64');

async function operation(node, body, signal = AbortSignal.timeout(30_000)) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Authorization': basic(node), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal,
	});
	const result = await response.json();
	assert.equal(response.status, 200, JSON.stringify(result));
	return result;
}

async function request(node, path, { method = 'GET', body, anonymous = false, signal } = {}) {
	const response = await fetch(`${node.httpURL}/${path}`, {
		method,
		headers: { ...(anonymous ? {} : { Authorization: basic(node) }), 'Content-Type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: signal ?? AbortSignal.timeout(30_000),
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

suite('Non-owner retrieval connection (harper-pro#1189)', { timeout: 300_000 }, (ctx) => {
	const contexts = [0, 1].map(() => ({ name: ctx.name }));
	const [reader, owner] = [0, 1].map((i) => () => contexts[i].harper);
	const ownedByOwner = {};
	let stoppedPid;

	before(async () => {
		await Promise.all(
			contexts.map(async (context, shard) => {
				context.harper = { hostname: await getNextAvailableLoopbackAddress() };
				context.harper.dataRootDir = await mkdtemp(
					join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
				);
				await cp(FIXTURE, join(context.harper.dataRootDir, 'components', basename(FIXTURE)), { recursive: true });
				await startHarper(context, {
					config: {
						authentication: { authorizeLocal: false },
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: false, level: 'warn' },
						replication: {
							threads: 1,
							securePort: context.harper.hostname + ':9933',
							shard,
							shards: [0, 1],
							pingInterval: 500,
							pingTimeout: PING_TIMEOUT,
							databases: '*',
						},
					},
				});
			})
		);
		const { operation_token: token } = await operation(owner(), {
			operation: 'create_authentication_tokens',
			authorization: owner().admin,
		});
		await operation(reader(), {
			operation: 'add_node',
			hostname: owner().hostname,
			authorization: 'Bearer ' + token,
			rejectUnauthorized: false,
		});
		await waitForCondition(
			async (signal) =>
				(
					await Promise.all([reader(), owner()].map((node) => operation(node, { operation: 'cluster_status' }, signal)))
				).every((status) =>
					['data', 'other'].every((database) =>
						status.connections[0]?.database_sockets.some((socket) => socket.database === database && socket.connected)
					)
				),
			{ description: 'both databases replicating in both directions' }
		);
		// Written on the owner, so the reader's HTTP worker serves no request that could open a connection first
		for (const table of ['Plain', 'Other']) {
			for (let i = 0; i < 16; i++) {
				const id = `${table.toLowerCase()}-${i}`;
				const response = await request(owner(), `${table}/${id}`, { method: 'PUT', body: { id, body: id } });
				assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response));
			}
			ownedByOwner[table] = await waitForCondition(
				async (signal) => {
					const [readerRows, ownerRows] = await Promise.all(
						[reader(), owner()].map(async (node) => {
							const { status, data } = await request(node, `HeldRows/?table=${table}`, { signal });
							assert.equal(status, 200, JSON.stringify(data));
							return data;
						})
					);
					// each node keeps only the rows it owns: all 16 split between them means the reader has caught up
					const held = new Set([...readerRows, ...ownerRows].map((row) => row.id));
					return held.size === 16 && readerRows.length + ownerRows.length === 16 && ownerRows[0]?.id;
				},
				{ description: `the ${table} rows to be split between the two owners` }
			);
		}
	});

	after(async () => {
		if (stoppedPid) process.kill(stoppedPid, 'SIGCONT');
		await stopAndTeardownNodes(contexts.map((context) => context.harper));
	});

	test("an anonymous read is the HTTP worker's first fetch from the owner", async () => {
		const id = ownedByOwner.Plain;
		const response = await request(reader(), `PublicPlain/${id}`, {
			anonymous: true,
			signal: AbortSignal.timeout(15_000),
		});
		assert.equal(response.status, 200, JSON.stringify(response));
		assert.deepEqual(response.data, { id, body: id });
		assert.doesNotMatch(await readLog(reader()), /Failed to create web socket/);
		const denied = await request(reader(), `Plain/${id}`, { anonymous: true, signal: AbortSignal.timeout(15_000) });
		assert.equal(denied.status, 401, 'the table itself still refuses the anonymous request');
	});

	test('a read whose owner connection cannot finish opening fails with a 502 within pingTimeout', async () => {
		// A stopped process still completes TCP handshakes from its listen backlog, so the TLS handshake stalls
		stoppedPid = await readNodePid(owner());
		process.kill(stoppedPid, 'SIGSTOP');
		const id = ownedByOwner.Other;
		const started = performance.now();
		const response = await request(reader(), `PublicOther/${id}`, {
			anonymous: true,
			signal: AbortSignal.timeout(30_000),
		});
		const elapsed = performance.now() - started;
		assert.equal(response.status, 502, JSON.stringify(response));
		assert.ok(elapsed < 2 * PING_TIMEOUT + 5000, `the read failed after ${Math.round(elapsed)}ms`);
		assert.match(
			await readLog(reader()),
			/Opening handshake has timed out/,
			'the read waited on the stalled handshake'
		);

		process.kill(stoppedPid, 'SIGCONT');
		stoppedPid = undefined;
		await waitForCondition(
			async (signal) => {
				const { status, data } = await request(reader(), `PublicOther/${id}`, { anonymous: true, signal });
				return status === 200 && data.body === id;
			},
			{ description: 'the retrieval connection to reopen once the owner resumes' }
		);
	});
});
