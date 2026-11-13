/**
 * harper-pro#1399 (HarperFast/harper#4390): a replicated write takes only its own expiry. The receiver applies an
 * origin transaction under its first event, so a `Plain` row written after an `Exp` row (table expiration) in one
 * transaction must not take `Exp`'s expiry: the replica would hide it once that passes, while the origin keeps it.
 */
import { suite, test, before, after } from 'node:test';
import { equal } from 'node:assert';
import { join } from 'node:path';
import { startHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { fetchWithRetry, sendOperation, stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const DATABASE = 'data';

const nodeConfig = (hostname) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true },
		replication: { securePort: hostname + ':9933', databases: [DATABASE] },
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true },
});

function get(node, path, signal) {
	return fetchWithRetry(`${node.httpURL}${path}`, {
		headers: {
			Authorization: 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
		},
		retries: 0,
		signal,
	});
}

function readable(node, table, id, signal) {
	return sendOperation(
		node,
		{ operation: 'search_by_id', database: DATABASE, table, ids: [id], get_attributes: ['id'] },
		{ signal }
	).then(
		(rows) => rows.length,
		() => -1
	);
}

async function deploy(node) {
	await sendOperation(node, {
		operation: 'deploy_component',
		project: 'replicated-expiry',
		payload: await targz(join(import.meta.dirname, 'fixture-replicated-expiry')),
		replicated: false,
		restart: true,
	});
	await waitForCondition(async (signal) => (await get(node, '/Plain/', signal).catch(() => null))?.status === 200, {
		timeoutMs: 90_000,
		description: `the fixture to be served on ${node.hostname}`,
	});
}

suite('a replicated write takes only its own expiry (harper-pro#1399)', { timeout: 300_000 }, (ctx) => {
	before(async () => {
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
		await Promise.all([deploy(ctx.A), deploy(ctx.B)]);
		await sendOperation(ctx.B, {
			operation: 'add_node',
			hostname: ctx.A.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: ctx.A.admin,
		});
		await sendOperation(ctx.A, { operation: 'upsert', database: DATABASE, table: 'Plain', records: [{ id: 'probe' }] });
		await waitForCondition((signal) => readable(ctx.B, 'Plain', 'probe', signal).then((count) => count === 1), {
			timeoutMs: 60_000,
			description: 'replication from A to B',
		});
	});

	after(() => stopAndTeardownNodes([ctx.A, ctx.B]));

	test('a row written after an expiring row in one transaction outlives that expiry on the replica', async () => {
		equal((await get(ctx.A, '/ExpiringThenPlain/after')).status, 200);
		equal((await get(ctx.A, '/PlainThenExpiring/before')).status, 200);
		await waitForCondition(
			async (signal) =>
				(await readable(ctx.B, 'Plain', 'after', signal)) === 1 &&
				(await readable(ctx.B, 'Plain', 'before', signal)) === 1,
			{ timeoutMs: 30_000, description: 'both Plain rows to reach B' }
		);
		await waitForCondition(
			async (signal) =>
				(await readable(ctx.B, 'Exp', 'after', signal)) === 0 && (await readable(ctx.B, 'Exp', 'before', signal)) === 0,
			{ timeoutMs: 60_000, description: 'the Exp rows to expire on B' }
		);
		equal(await readable(ctx.B, 'Plain', 'after'), 1, 'B keeps the Plain row written after Exp');
		equal(await readable(ctx.B, 'Plain', 'before'), 1, 'B keeps the Plain row written before Exp');
		equal(await readable(ctx.A, 'Plain', 'after'), 1, 'A keeps the Plain row written after Exp');
	});
});
