/**
 * harper-pro#883: a `replicate: false` table never leaves its node — not through the full copy a
 * joining peer requests, not through blob transfer, not through live audit forwarding, and not
 * through the schema handshake.
 *
 * Node A deploys a fixture declaring `LocalKeyspace @table(replicate: false)` (a Blob attribute, so
 * every row carries a file-backed blob) next to `SharedRecord @table`. Node B has no application and
 * no such table, so its subscription request excludes nothing: before the fix the leader's only
 * table filter was the peer's own request, and B ended the join with the table (created from
 * DB_SCHEMA), the row and the blob file. B joins A with `add_node isLeader:true`, the same
 * COPY_START path a clone takes. Every assertion here also holds for a node whose plugin declares
 * the table itself; this suite deliberately leaves B undeclared, since that is the case the source
 * alone has to enforce.
 */
import { suite, test, before, after } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { fetchWithRetry, sendOperation, stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const DATABASE = 'data';
const LOCAL_TABLE = 'LocalKeyspace';
const SHARED_TABLE = 'SharedRecord';
const PROJECT = 'replicate-false';
const FIXTURE_PATH = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'fixture-replicate-false');
// Above FILE_STORAGE_THRESHOLD (8 KiB), so the value is stored as a blob file rather than inline; a
// string on a Blob-typed attribute is coerced to a blob by the ordinary write path.
const BLOB_PAYLOAD = 'replicate-false payload '.repeat(1024);

const config = (hostname) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true },
		replication: { port: hostname + ':9933', securePort: null, databases: [DATABASE] },
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true },
});

function listBlobFiles(dataRootDir, db = DATABASE) {
	const root = join(dataRootDir, 'blobs', db);
	if (!existsSync(root)) return [];
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.push(path);
		}
	};
	walk(root);
	return files.sort();
}

async function describeTable(node, table, signal) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ operation: 'describe_table', database: DATABASE, table }),
		signal,
	});
	return { status: response.status, body: await response.json() };
}

async function waitForTable(node, table) {
	await waitForCondition(
		async (signal) => {
			const response = await fetchWithRetry(`${node.httpURL}/${table}/`, {
				headers: {
					Authorization: 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
				},
				retries: 0,
				signal,
			}).catch(() => null);
			return response?.status === 200;
		},
		{ timeoutMs: 60_000, description: `${table} to be served on ${node.hostname}` }
	);
}

function waitForSharedRecord(node, id) {
	return waitForCondition(
		async (signal) => {
			const rows = await sendOperation(
				node,
				{
					operation: 'search_by_id',
					database: DATABASE,
					table: SHARED_TABLE,
					ids: [id],
					get_attributes: ['id', 'value'],
				},
				{ signal }
			).catch(() => []);
			return rows.find((row) => row?.id === id);
		},
		{ timeoutMs: 90_000, description: `${SHARED_TABLE}/${id} to arrive on ${node.hostname}` }
	);
}

async function assertNothingLocalOn(node, signal) {
	const described = await describeTable(node, LOCAL_TABLE, signal);
	equal(described.status, 404, `${LOCAL_TABLE} must not exist on ${node.hostname}: ${JSON.stringify(described.body)}`);
	deepEqual(listBlobFiles(node.dataRootDir), [], `no blob file may reach ${node.hostname}`);
}

suite('replicate: false never leaves the node (harper-pro#883)', { timeout: 300_000 }, (ctx) => {
	before(async () => {
		const [hostnameA, hostnameB] = await Promise.all([
			getNextAvailableLoopbackAddress(),
			getNextAvailableLoopbackAddress(),
		]);
		const nodeA = { name: ctx.name, harper: { hostname: hostnameA } };
		const nodeB = { name: ctx.name, harper: { hostname: hostnameB } };
		const starts = await Promise.allSettled([
			startHarper(nodeA, config(hostnameA)),
			startHarper(nodeB, config(hostnameB)),
		]);
		ctx.nodeA = nodeA.harper;
		ctx.nodeB = nodeB.harper;
		const startErrors = starts.filter((result) => result.status === 'rejected').map((result) => result.reason);
		if (startErrors.length) throw new AggregateError(startErrors, 'Failed to start the replicate:false nodes');

		// Only A carries the application: B must learn nothing about LocalKeyspace from the wire.
		await sendOperation(ctx.nodeA, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await targz(FIXTURE_PATH),
			replicated: false,
			restart: true,
		});
		await waitForTable(ctx.nodeA, SHARED_TABLE);
		await waitForTable(ctx.nodeA, LOCAL_TABLE);
		await sendOperation(ctx.nodeA, {
			operation: 'insert',
			database: DATABASE,
			table: LOCAL_TABLE,
			records: [{ id: 'local-before-join', payload: BLOB_PAYLOAD }],
		});
		await sendOperation(ctx.nodeA, {
			operation: 'insert',
			database: DATABASE,
			table: SHARED_TABLE,
			records: [{ id: 'shared-before-join', value: 'copied' }],
		});
	});

	after(async () => {
		// A restarted on deploy, so its spawned handle is stale; stop by pid before teardown.
		await stopAndTeardownNodes([ctx.nodeA, ctx.nodeB]);
	});

	test('the full copy and the live tail deliver the shared table only, and no blob', async () => {
		const { nodeA, nodeB } = ctx;
		// premise: the row on A is blob-backed, so a leak would be a file on B
		ok(listBlobFiles(nodeA.dataRootDir).length > 0, 'the LocalKeyspace row on A must be stored as a blob file');
		const describedOnA = await describeTable(nodeA, LOCAL_TABLE);
		equal(describedOnA.body?.replicate, false, 'premise: A declares the table replicate: false');

		await sendOperation(nodeB, {
			operation: 'add_node',
			hostname: nodeA.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: nodeA.admin,
		});
		const copied = await waitForSharedRecord(nodeB, 'shared-before-join');
		equal(copied.value, 'copied');

		// A row written after the join rides the live tail, which starts only once the copy is
		// complete — so its arrival proves the copy finished before the negative assertions below.
		await sendOperation(nodeA, {
			operation: 'insert',
			database: DATABASE,
			table: LOCAL_TABLE,
			records: [{ id: 'local-after-join', payload: BLOB_PAYLOAD }],
		});
		await sendOperation(nodeA, {
			operation: 'insert',
			database: DATABASE,
			table: SHARED_TABLE,
			records: [{ id: 'shared-after-join', value: 'forwarded' }],
		});
		const forwarded = await waitForSharedRecord(nodeB, 'shared-after-join');
		equal(forwarded.value, 'forwarded');

		await assertNothingLocalOn(nodeB);
	});
});
