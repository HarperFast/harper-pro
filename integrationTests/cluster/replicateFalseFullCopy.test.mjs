/**
 * harper-pro#883: a `replicate: false` table never leaves its node — not through the full copy a
 * joining peer requests, not through blob transfer, not through live audit forwarding, and not
 * through the schema handshake.
 *
 * Node A declares LocalKeyspace local either at creation or by redeploying a populated replicated
 * table. Its Blob attribute makes every row file-backed, beside `SharedRecord @table`. Node B has
 * no application or such table, so its subscription request excludes nothing — the source alone has to
 * enforce, which is why B is deliberately left undeclared. B joins A with `add_node isLeader:true`,
 * the same COPY_START path a clone takes.
 */
import { suite, test, before, after } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

async function deployFixture(node, fixture) {
	await sendOperation(node, {
		operation: 'deploy_component',
		project: PROJECT,
		payload: await targz(fixture),
		replicated: false,
		restart: true,
	});
	await waitForTable(node, SHARED_TABLE);
	await waitForTable(node, LOCAL_TABLE);
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

for (const redeclare of [false, true]) {
	suite(
		`replicate: false ${redeclare ? 'after redeploy' : 'at creation'} (harper-pro#883)`,
		{ timeout: 420_000 },
		(ctx) => {
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
				const fixture = mkdtempSync(join(tmpdir(), 'replicate-false-'));
				try {
					copyFileSync(join(FIXTURE_PATH, 'config.yaml'), join(fixture, 'config.yaml'));
					const schema = readFileSync(join(FIXTURE_PATH, 'schema.graphql'), 'utf8');
					writeFileSync(
						join(fixture, 'schema.graphql'),
						redeclare ? schema.replace('replicate: false', 'replicate: true') : schema
					);
					await deployFixture(ctx.nodeA, fixture);
				} finally {
					rmSync(fixture, { recursive: true, force: true });
				}
				const initial = await describeTable(ctx.nodeA, LOCAL_TABLE);
				equal(initial.status, 200);
				equal(initial.body.replicate, redeclare, 'the initial declaration must match the scenario');
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
				if (redeclare) {
					await deployFixture(ctx.nodeA, FIXTURE_PATH);
					await waitForCondition(
						async (signal) => {
							const described = await describeTable(ctx.nodeA, LOCAL_TABLE, signal);
							return described.status === 200 && described.body.replicate === false;
						},
						{ timeoutMs: 60_000, description: `${LOCAL_TABLE} to become local after redeploy` }
					);
					const rows = await sendOperation(ctx.nodeA, {
						operation: 'search_by_id',
						database: DATABASE,
						table: LOCAL_TABLE,
						ids: ['local-before-join'],
						get_attributes: ['id'],
					});
					deepEqual(rows, [{ id: 'local-before-join' }], 'the existing row must survive the redeploy');
				}
			});

			after(async () => {
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
		}
	);
}
