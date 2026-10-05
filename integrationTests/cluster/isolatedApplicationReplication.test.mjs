/**
 * harper-pro#974: a worker dedicated to an isolated application is an `http` worker too, but replication must
 * never place a peer subscription or a database's record-lock coordination on it. Each node runs one pool
 * worker plus the dedicated one, so a round robin over every http worker would land every other database there.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { ensureTableExists, sendOperation, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const ISOLATED_APP = 'isolated-app';
const FIXTURE = join(import.meta.dirname, 'fixture-isolated-app');
const DATABASES = ['iso0', 'iso1', 'iso2'];
// Windows has no UDS mirrors, so core refuses a dedicated worker there.
const UNSUPPORTED_HERE = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

async function startNode(suiteName, { isolated = false, recordLocks = false } = {}) {
	const hostname = await getNextAvailableLoopbackAddress();
	const dataRootDir = await mkdtemp(
		join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
	);
	const config = {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: true, console: true, level: 'warn' },
		threads: { count: 1 },
		replication: { securePort: hostname + ':9933', ...(recordLocks && { recordLocks: true }) },
	};
	if (isolated) {
		await cp(FIXTURE, join(dataRootDir, 'components', ISOLATED_APP), { recursive: true, dereference: true });
		// a dedicated worker is reachable only through UDS mirrors of the secure port
		config.tls = { unixDomainSockets: true };
		config[ISOLATED_APP] = { isolated: true };
	}
	const ctx = { name: suiteName, harper: { hostname, dataRootDir } };
	await startHarper(ctx, { config, env: { HARPER_NO_FLUSH_ON_EXIT: true } });
	return ctx.harper;
}

async function createDatabases(node) {
	for (const database of DATABASES) await ensureTableExists(node, { database, table: 'Probe', primary_key: 'id' });
}

/** The pool worker ids and the dedicated worker's id, after asserting the dedicated worker is running. */
async function threadsOf(node) {
	const { threads } = await sendOperation(node, { operation: 'system_information', attributes: ['threads'] });
	const pool = threads.filter((thread) => thread.name === 'http' && !thread.application).map((t) => t.threadId);
	const dedicated = threads.filter((thread) => thread.application === ISOLATED_APP).map((t) => t.threadId);
	equal(dedicated.length, 1, `expected one dedicated worker: ${JSON.stringify(threads)}`);
	equal(pool.length, 1, `expected one pool worker: ${JSON.stringify(threads)}`);
	return { pool, dedicated: dedicated[0] };
}

suite('replication stays off an isolated application worker', { skip: UNSUPPORTED_HERE, timeout: 240_000 }, (ctx) => {
	before(async () => {
		ctx.nodes = [];
		ctx.nodes.push(await startNode(ctx.name, { isolated: true }));
		ctx.nodes.push(await startNode(ctx.name));
		for (const node of ctx.nodes) await createDatabases(node);
		await sendOperation(ctx.nodes[0], {
			operation: 'add_node',
			hostname: ctx.nodes[1].hostname,
			rejectUnauthorized: false,
			authorization: ctx.nodes[1].admin,
		});
	});

	after(async () => {
		await Promise.all((ctx.nodes ?? []).map((node) => teardownHarper({ harper: node }).catch(() => null)));
	});

	test('places every subscription on a pool worker', async () => {
		const [isolatedNode] = ctx.nodes;
		const { pool, dedicated } = await threadsOf(isolatedNode);
		let lastSockets;
		const sockets = await waitForCondition(
			async (signal) => {
				const status = await sendOperation(isolatedNode, { operation: 'cluster_status' }, { signal });
				lastSockets = (status.connections ?? []).flatMap((connection) => connection.database_sockets ?? []);
				const placed = lastSockets.filter((socket) => typeof socket.threadId === 'number');
				const databases = new Set(placed.map((socket) => socket.database));
				return DATABASES.every((database) => databases.has(database)) ? placed : undefined;
			},
			{ timeoutMs: 90_000, description: () => `a placed socket per database: ${JSON.stringify(lastSockets)}` }
		);
		for (const socket of sockets)
			ok(
				pool.includes(socket.threadId),
				`${socket.database} is on thread ${socket.threadId}, not the pool ${pool} (dedicated: ${dedicated})`
			);
	});

	test('applies records in both directions on every database', async () => {
		const [isolatedNode, plainNode] = ctx.nodes;
		for (const [from, to] of [
			[plainNode, isolatedNode],
			[isolatedNode, plainNode],
		]) {
			const id = `from-${from.hostname}`;
			for (const database of DATABASES)
				await sendOperation(from, { operation: 'upsert', database, table: 'Probe', records: [{ id }] });
			await waitForCondition(
				async (signal) => {
					for (const database of DATABASES) {
						const found = await sendOperation(
							to,
							{ operation: 'search_by_id', database, table: 'Probe', ids: [id], get_attributes: ['id'] },
							{ signal }
						);
						if (found.length !== 1) return false;
					}
					return true;
				},
				{ timeoutMs: 60_000, description: `${id} on ${to.hostname} in every database` }
			);
		}
	});
});

suite(
	'record-lock coordination stays off an isolated application worker',
	{ skip: UNSUPPORTED_HERE, timeout: 180_000 },
	(ctx) => {
		before(async () => {
			ctx.node = await startNode(ctx.name, { isolated: true, recordLocks: true });
			await createDatabases(ctx.node);
		});

		after(async () => {
			if (ctx.node) await teardownHarper({ harper: ctx.node }).catch(() => null);
		});

		test('assigns every database a pool worker as owner', async () => {
			const { pool, dedicated } = await threadsOf(ctx.node);
			let lastLocks;
			const locks = await waitForCondition(
				async (signal) => {
					lastLocks = (await sendOperation(ctx.node, { operation: 'cluster_status' }, { signal })).recordLocks ?? {};
					return DATABASES.every((database) => lastLocks[database]) ? lastLocks : undefined;
				},
				{ timeoutMs: 60_000, description: () => `an owner per database: ${JSON.stringify(lastLocks)}` }
			);
			for (const [database, { ownerThreadId }] of Object.entries(locks))
				ok(
					pool.includes(ownerThreadId),
					`${database} is coordinated by ${ownerThreadId}, not the pool ${pool} (dedicated: ${dedicated})`
				);
		});
	}
);
