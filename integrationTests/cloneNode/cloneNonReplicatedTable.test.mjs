/**
 * harper-pro#883: a fresh clone of a node carrying a `replicate: false` table receives none of its
 * records and none of its blobs, and its copy of the table comes from its own (cloned) application
 * schema — never from the leader's schema handshake or from cloneNode's `describe_all` pre-creation.
 *
 * The leader runs the same fixture as the cluster suite (`LocalKeyspace @table(replicate: false)`
 * with a Blob attribute, `SharedRecord @table`). `cloneApplications` clones that application, so the
 * clone declares the table itself; what this suite pins is that `cloneSchemas` pre-creates the
 * replicated table and not the local one (a pre-created twin would be replicated by default until
 * the application's own declaration corrected it), and that no row or blob crosses.
 */
import { suite, test, before, after } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import {
	fetchWithRetry,
	readLog,
	sendOperation,
	stopAndTeardownNodes,
	waitForCondition,
} from '../cluster/clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const DATABASE = 'data';
const LOCAL_TABLE = 'LocalKeyspace';
const SHARED_TABLE = 'SharedRecord';
const PROJECT = 'replicate-false';
const FIXTURE_PATH = join(import.meta.dirname, '..', 'cluster', 'fixture-replicate-false');
// Above FILE_STORAGE_THRESHOLD (8 KiB), so the value is stored as a blob file rather than inline.
const BLOB_PAYLOAD = 'replicate-false payload '.repeat(1024);

const nodeConfig = (hostname) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false },
	replication: { port: hostname + ':9933', securePort: null },
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

function waitForAvailable(node) {
	return waitForCondition(
		async (signal) => {
			const status = await sendOperation(node, { operation: 'get_status', id: 'availability' }, { signal }).catch(
				() => null
			);
			return status?.status === 'Available';
		},
		{ timeoutMs: 180_000, pollMs: 2_000, description: `${node.hostname} to become Available` }
	);
}

function waitForCompletedClone(node) {
	return waitForCondition(
		() => {
			try {
				const attempt = JSON.parse(readFileSync(join(node.dataRootDir, '.cloneAttempt.json'), 'utf8'));
				return typeof attempt?.completedAt === 'number' ? attempt : undefined;
			} catch {
				return undefined;
			}
		},
		{ timeoutMs: 60_000, description: 'the clone attempt to record its completion' }
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

suite('Clone Node - replicate: false table stays on the leader (harper-pro#883)', { timeout: 420_000 }, (ctx) => {
	before(async () => {
		const leaderCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await startHarper(leaderCtx, {
			config: nodeConfig(leaderCtx.harper.hostname),
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});
		ctx.leader = leaderCtx.harper;
		await sendOperation(ctx.leader, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await targz(FIXTURE_PATH),
			restart: true,
		});
		await waitForTable(ctx.leader, SHARED_TABLE);
		await waitForTable(ctx.leader, LOCAL_TABLE);
		await sendOperation(ctx.leader, {
			operation: 'insert',
			database: DATABASE,
			table: LOCAL_TABLE,
			records: [{ id: 'local-on-leader', payload: BLOB_PAYLOAD }],
		});
		await sendOperation(ctx.leader, {
			operation: 'insert',
			database: DATABASE,
			table: SHARED_TABLE,
			records: [{ id: 'shared-on-leader', value: 'cloned' }],
		});
	});

	after(async () => {
		await stopAndTeardownNodes([ctx.leader, ctx.clone]);
	});

	test('the clone gets the shared row, no local row, no blob, and no pre-created local table', async () => {
		const { leader } = ctx;
		ok(listBlobFiles(leader.dataRootDir).length > 0, 'premise: the LocalKeyspace row on the leader is a blob file');
		const token = await sendOperation(leader, {
			operation: 'create_authentication_tokens',
			username: leader.admin.username,
			password: leader.admin.password,
		});

		const cloneCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await startHarper(cloneCtx, {
			config: nodeConfig(cloneCtx.harper.hostname),
			env: {
				HDB_LEADER_URL: `http://${leader.hostname}:9925`,
				HDB_LEADER_TOKEN: token.operation_token,
				ALLOW_SELF_SIGNED: true,
				HARPER_NO_FLUSH_ON_EXIT: true,
			},
		});
		ctx.clone = cloneCtx.harper;
		const clone = ctx.clone;
		await waitForAvailable(clone);
		await waitForCompletedClone(clone);

		const cloned = await waitForSharedRecord(clone, 'shared-on-leader');
		equal(cloned.value, 'cloned');

		// The clone's own copy of the application declares the table; it must be empty and its
		// declaration must be the application's (`replicate: false`), not a handshake twin.
		const described = await sendOperation(clone, {
			operation: 'describe_table',
			database: DATABASE,
			table: LOCAL_TABLE,
		});
		equal(described.replicate, false, `the clone's ${LOCAL_TABLE} must come from its own schema`);
		const localRows = await sendOperation(clone, {
			operation: 'search_by_id',
			database: DATABASE,
			table: LOCAL_TABLE,
			ids: ['local-on-leader'],
			get_attributes: ['id'],
		});
		deepEqual(localRows, [], `${LOCAL_TABLE} rows must not reach the clone`);
		deepEqual(listBlobFiles(clone.dataRootDir), [], 'no blob file may reach the clone');

		const cloneLog = await readLog(clone);
		ok(
			cloneLog.includes(`Pre-created table '${DATABASE}.${SHARED_TABLE}' from leader schema`),
			'premise: cloneSchemas ran and pre-created the replicated table'
		);
		ok(
			!cloneLog.includes(`Pre-created table '${DATABASE}.${LOCAL_TABLE}' from leader schema`),
			`cloneSchemas must not pre-create ${LOCAL_TABLE}`
		);
	});
});
