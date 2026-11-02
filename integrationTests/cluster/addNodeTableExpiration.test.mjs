/**
 * harper-pro#1179: a table a node receives through add_node keeps the sender's table-level expiration,
 * and a later `@table(expiration)` declaration on that node updates the table it already has.
 *
 * The first suite is the issue's reproduction: A creates the table with `create_table expiration`, B has no
 * declaration of it and gets it only from replication. The second gives A the tables with no expiration,
 * so B's own declaration, deployed after the join, is the only source of one. Its keyless table (no
 * `@primaryKey`) is the shape whose expiration a restart did not restore.
 */
import { suite, test, before, after } from 'node:test';
import { equal } from 'node:assert/strict';
import { join } from 'node:path';
import { startHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import {
	fetchWithRetry,
	restartNode,
	sendOperation,
	stopAndTeardownNodes,
	waitForCondition,
} from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const DATABASE = 'data';
const PROJECT = 'table-expiration';

const nodeConfig = (hostname) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true },
		replication: { securePort: hostname + ':9933', databases: [DATABASE] },
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true },
});

async function startPair(ctx) {
	const [hostnameA, hostnameB] = await Promise.all([
		getNextAvailableLoopbackAddress(),
		getNextAvailableLoopbackAddress(),
	]);
	const nodeA = { name: ctx.name, harper: { hostname: hostnameA } };
	const nodeB = { name: ctx.name, harper: { hostname: hostnameB } };
	const starts = await Promise.allSettled([
		startHarper(nodeA, nodeConfig(hostnameA)),
		startHarper(nodeB, nodeConfig(hostnameB)),
	]);
	ctx.A = nodeA.harper;
	ctx.B = nodeB.harper;
	const failed = starts.find((start) => start.status === 'rejected');
	if (failed) throw failed.reason;
}

function describeTable(node, table, signal) {
	return sendOperation(
		node,
		{ operation: 'describe_table', database: DATABASE, table, skip_record_count: true },
		{ signal }
	);
}

async function waitForExpiration(node, table, expected) {
	let seen;
	await waitForCondition(
		async (signal) => {
			seen = (await describeTable(node, table, signal).catch(() => undefined))?.expiration;
			return seen === expected;
		},
		{
			timeoutMs: 30_000,
			description: () => `${table} on ${node.hostname} to report expiration ${expected} (saw ${seen})`,
		}
	);
}

function storedCount(node, table, signal) {
	return sendOperation(
		node,
		{ operation: 'describe_table', database: DATABASE, table, exact_count: true },
		{ signal }
	).then((described) => described.record_count);
}

function readableCount(node, table, ids, signal) {
	return sendOperation(
		node,
		{ operation: 'search_by_id', database: DATABASE, table, ids, get_attributes: ['id'] },
		{ signal }
	).then(
		(rows) => rows.length,
		() => -1
	);
}

async function addNode(ctx) {
	await sendOperation(ctx.B, {
		operation: 'add_node',
		hostname: ctx.A.hostname,
		rejectUnauthorized: false,
		isLeader: true,
		authorization: ctx.A.admin,
	});
}

async function deploy(node, fixture) {
	await sendOperation(node, {
		operation: 'deploy_component',
		project: PROJECT,
		payload: await targz(join(import.meta.dirname, fixture)),
		replicated: false,
		restart: true,
	});
	await waitForCondition(
		async (signal) => {
			const response = await fetchWithRetry(`${node.httpURL}/Session/`, {
				headers: {
					Authorization: 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
				},
				retries: 0,
				signal,
			}).catch(() => null);
			return response?.status === 200;
		},
		{ timeoutMs: 90_000, description: `${fixture} to be served on ${node.hostname}` }
	);
}

suite('add_node keeps the sender table-level expiration (harper-pro#1179)', { timeout: 300_000 }, (ctx) => {
	const TTL_S = 20;
	const ids = Array.from({ length: 50 }, (_, i) => 'e' + i);

	before(async () => {
		await startPair(ctx);
		await sendOperation(ctx.A, {
			operation: 'create_table',
			database: DATABASE,
			table: 'TtlCache',
			primary_key: 'id',
			expiration: TTL_S,
		});
	});

	after(() => stopAndTeardownNodes([ctx.A, ctx.B]));

	test('the joined node reports the expiration and expires and evicts rows from the copy and its own writes', async () => {
		await sendOperation(ctx.A, {
			operation: 'upsert',
			database: DATABASE,
			table: 'TtlCache',
			records: ids.map((id) => ({ id, v: 1 })),
		});
		await addNode(ctx);
		await waitForCondition(
			(signal) => readableCount(ctx.B, 'TtlCache', ids, signal).then((count) => count === ids.length),
			{
				timeoutMs: 60_000,
				description: 'the base copy to deliver the rows to B',
			}
		);
		const described = await describeTable(ctx.A, 'TtlCache');
		equal(described.expiration, `${TTL_S}s`);
		equal((await describeTable(ctx.B, 'TtlCache')).expiration, described.expiration);

		// B assigns this row's deadline itself, from its own table's expiration
		await sendOperation(ctx.B, {
			operation: 'upsert',
			database: DATABASE,
			table: 'TtlCache',
			records: [{ id: 'local', v: 1 }],
		});
		await waitForCondition(
			(signal) => readableCount(ctx.B, 'TtlCache', [...ids, 'local'], signal).then((count) => count === 0),
			{ timeoutMs: (TTL_S + 40) * 1000, pollMs: 2000, description: 'rows on B to expire' }
		);
		// the reads above evict lazily; an unprompted scan on a thread that loaded the table runs daily (harper#2831)
		let stored;
		await waitForCondition(
			async (signal) => {
				stored = await storedCount(ctx.B, 'TtlCache', signal);
				return stored === 0;
			},
			{ timeoutMs: 60_000, pollMs: 2000, description: () => `B to evict its expired rows (${stored} stored)` }
		);
	});
});

suite('a declaration on the joined node updates a table it received (harper-pro#1179)', { timeout: 420_000 }, (ctx) => {
	before(async () => {
		await startPair(ctx);
		await deploy(ctx.A, 'fixture-table-expiration-undeclared');
	});

	after(() => stopAndTeardownNodes([ctx.A, ctx.B]));

	test('a deploy updates keyed and keyless tables without a restart, and a restart keeps it', async () => {
		await sendOperation(ctx.A, {
			operation: 'upsert',
			database: DATABASE,
			table: 'Session',
			records: [{ id: 's1', user: 'u' }],
		});
		await addNode(ctx);
		await waitForCondition(
			async (signal) =>
				(await describeTable(ctx.B, 'cache', signal).catch(() => undefined)) &&
				(await readableCount(ctx.B, 'Session', ['s1'], signal)) === 1,
			{ timeoutMs: 60_000, description: 'the tables to reach B' }
		);
		equal((await describeTable(ctx.B, 'cache')).expiration, undefined);
		equal((await describeTable(ctx.B, 'Session')).expiration, undefined);

		await deploy(ctx.B, 'fixture-table-expiration-declared');
		await waitForExpiration(ctx.B, 'Session', '300s');
		await waitForExpiration(ctx.B, 'cache', '600s');

		await restartNode(ctx.B);
		await waitForCondition(
			(signal) =>
				describeTable(ctx.B, 'cache', signal)
					.then(() => true)
					.catch(() => false),
			{ timeoutMs: 120_000, description: 'B to serve operations after its restart' }
		);
		await waitForExpiration(ctx.B, 'Session', '300s');
		await waitForExpiration(ctx.B, 'cache', '600s');
		equal((await describeTable(ctx.B, 'cache')).audit, false, "the keyless declaration's other settings persist too");
		equal((await describeTable(ctx.A, 'cache')).expiration, undefined, "B's declaration must not reach A");
	});
});
