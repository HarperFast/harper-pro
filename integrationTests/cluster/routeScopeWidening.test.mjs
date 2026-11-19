/**
 * A route that widens never resumes over history it did not receive (harper-pro#1142, #1212).
 *
 * Topology, all on `data`:
 *
 *   A ─ B ─ C      A writes; B relays A to C; C never connects to A.
 *
 * 1. #1142, restart variant. C restarts with a receive route that excludes `Skipped` from B, so B's route to C is
 *    partial, and A writes Skipped rows (they reach B, not C) and Progress rows after them. C restarts with the route
 *    widened and must copy A's Skipped rows. The route row is stripped of coverage evidence before each restart while
 *    B is down: before the narrowing so nothing on it shows full coverage, and before the widening so B's own entry
 *    shows no partial coverage, as for a direct peer whose floor sent no certificate in the window. Only the route's
 *    own record can say it was narrowed.
 * 2. #1212. `Flipped` starts `replicate: false` on every node and A writes rows into it. The component is redeployed
 *    with `replicate: true` on A, then B, then C, each followed by a restart. A table entering scope changes no route's
 *    coverage, so only the route's table scope says it widened: B and then C must copy A's Flipped rows.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const FIXTURE_PATH = join(TEST_DIR, 'fixture-route-scope');
const PROJECT = 'route-scope';
const CONVERGE_TIMEOUT_MS = 120_000;
const SUITE_TIMEOUT_MS = 900_000;

const nodeOptions = (node, routes) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true },
		replication: { port: node.hostname + ':9933', securePort: null, databases: ['data'], routes },
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_ORIGIN_FLOOR_INTERVAL_MS: '5000' },
});

async function startNode(node, routes = []) {
	const started = (await startHarper({ name: node.name, harper: node }, nodeOptions(node, routes))).harper;
	return Object.assign(node, started);
}

async function startNewNode(suiteName) {
	const nodeCtx = { name: suiteName, harper: { hostname: await getNextAvailableLoopbackAddress() } };
	await startHarper(nodeCtx, nodeOptions(nodeCtx.harper, []));
	return Object.assign(nodeCtx.harper, { name: nodeCtx.name });
}

const addNode = (node, peer) =>
	sendOperation(node, {
		operation: 'add_node',
		hostname: peer.hostname,
		rejectUnauthorized: false,
		authorization: peer.admin,
	});

// B's route to C carries `data` without Skipped; the system database stays whole
const narrowedRoute = (peer) => ({
	hostname: peer.hostname,
	port: 9933,
	replicates: {
		sends: true,
		receivesFrom: [{ database: 'system' }, { database: 'data', excludeTables: ['Skipped'] }],
	},
});

const upsert = (node, table, ids) =>
	sendOperation(node, { operation: 'upsert', database: 'data', table, records: ids.map((id) => ({ id })) });

async function holds(node, table, ids, signal) {
	const rows = await sendOperation(
		node,
		{ operation: 'search_by_id', database: 'data', table, ids, get_attributes: ['id'] },
		{ signal }
	);
	return ids.every((id) => rows.some((row) => row.id === id));
}

const waitForRows = (node, table, ids) =>
	waitForCondition((signal) => holds(node, table, ids, signal), {
		timeoutMs: CONVERGE_TIMEOUT_MS,
		description: `${table} ${ids.join(', ')} to reach ${node.hostname}`,
	});

async function describeFlipped(node, signal) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
		},
		body: JSON.stringify({ operation: 'describe_table', database: 'data', table: 'Flipped' }),
		signal,
	});
	return response.ok ? response.json() : undefined;
}

/** Deploys the fixture with Flipped's `replicate` set; `restart` restarts the node so every route requests again. */
async function deploy(node, replicateFlipped, restart) {
	const fixture = mkdtempSync(join(tmpdir(), 'route-scope-'));
	try {
		copyFileSync(join(FIXTURE_PATH, 'config.yaml'), join(fixture, 'config.yaml'));
		copyFileSync(join(FIXTURE_PATH, 'resources.js'), join(fixture, 'resources.js'));
		const schema = readFileSync(join(FIXTURE_PATH, 'schema.graphql'), 'utf8');
		writeFileSync(
			join(fixture, 'schema.graphql'),
			replicateFlipped ? schema.replace('replicate: false', 'replicate: true') : schema
		);
		await sendOperation(node, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await targz(fixture),
			replicated: false,
			restart: !restart,
		});
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
	if (restart) {
		await stopNodeProcess(node);
		await startNode(node);
	}
	await waitForCondition(
		async (signal) => (await describeFlipped(node, signal).catch(() => undefined))?.replicate === replicateFlipped,
		{
			timeoutMs: CONVERGE_TIMEOUT_MS,
			description: `Flipped on ${node.hostname} to declare replicate: ${replicateFlipped}`,
		}
	);
}

async function routeState(node, peer, clear) {
	const response = await fetch(`${node.httpURL}/RouteState`, {
		signal: AbortSignal.timeout(10_000),
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
		},
		body: JSON.stringify({ peer: peer.hostname, clear }),
	});
	ok(response.ok, `RouteState on ${node.hostname}: ${response.status}`);
	return response.json();
}

const logPath = (node) => join(node.logDir ?? join(node.dataRootDir, 'log'), 'hdb.log');
const readText = (path) =>
	readFile(path, 'utf8').catch((error) => (error.code === 'ENOENT' ? '' : Promise.reject(error)));
const logMark = async (node) => ({ path: logPath(node), length: (await readText(logPath(node))).length });
/** What the node logged since `mark`; a restart may have moved its log. */
async function logSince(node, mark) {
	const log = await readText(logPath(node));
	return logPath(node) === mark.path ? log.slice(mark.length) : log;
}

suite(
	'A widened route copies what it never received (harper-pro#1142, #1212)',
	{ timeout: SUITE_TIMEOUT_MS },
	(ctx) => {
		before(async () => {
			// every node that started is kept for teardown, even when another failed to
			const started = await Promise.allSettled([
				startNewNode(ctx.name),
				startNewNode(ctx.name),
				startNewNode(ctx.name),
			]);
			[ctx.A, ctx.B, ctx.C] = started.map((result) => result.value);
			const failed = started.find((result) => result.status === 'rejected');
			if (failed) throw failed.reason;
			const { A, B, C } = ctx;
			await Promise.all([A, B, C].map((node) => deploy(node, false, false)));
			await addNode(A, B);
			await addNode(B, C);
			await upsert(A, 'Progress', ['seed']);
			await Promise.all([waitForRows(B, 'Progress', ['seed']), waitForRows(C, 'Progress', ['seed'])]);
		});

		after(async () => {
			await stopAndTeardownNodes([ctx.A, ctx.B, ctx.C].filter(Boolean));
		});

		test('a relayed origin missed while the route was partial is copied when it widens after a restart (#1142)', async () => {
			const { A, B, C } = ctx;
			// rewritten while B is down, so no certificate lands between the rewrite and C's next request
			await stopNodeProcess(B);
			const cleared = await routeState(C, B, 'all');
			ok(cleared.found && cleared.nodes.length > 0, `C's route row for B: ${JSON.stringify(cleared)}`);
			await stopNodeProcess(C);
			await startNode(B);
			await startNode(C, [narrowedRoute(B)]);

			const skipped = ['skipped-1', 'skipped-2'];
			await upsert(A, 'Skipped', skipped);
			await waitForRows(B, 'Skipped', skipped);
			await upsert(A, 'Progress', ['after-skipped']);
			await waitForRows(C, 'Progress', ['after-skipped']);
			for (const id of skipped)
				ok(!(await holds(C, 'Skipped', [id])), `premise: the narrowed route did not deliver ${id}`);

			await stopNodeProcess(B);
			const narrowed = await routeState(C, B, 'direct');
			await stopNodeProcess(C);
			await startNode(B);
			const mark = await logMark(C);
			await startNode(C, []);
			await waitForRows(C, 'Skipped', skipped);
			ok(narrowed.scope?.full === false, `C recorded B's route as narrowed: ${JSON.stringify(narrowed.scope)}`);
			// the older rule copies for a route whose own entry is marked partial; only the scope record names this one
			const direct = narrowed.nodes.find((node) => node.id === narrowed.peerId);
			ok(!direct?.partialHistory, `premise: B's own entry carries no partial mark: ${JSON.stringify(direct)}`);
			ok(
				(await logSince(C, mark)).includes(`Route coverage widened to full for ${B.hostname} on database data`),
				'C requested the copy because the route widened'
			);
		});

		test('a table whose replicate turns on is copied below the old floor (#1212)', async () => {
			const { A, B, C } = ctx;
			const flipped = ['flipped-1', 'flipped-2'];
			await upsert(A, 'Flipped', flipped);
			await upsert(A, 'Progress', ['after-flipped']);
			await Promise.all([waitForRows(B, 'Progress', ['after-flipped']), waitForRows(C, 'Progress', ['after-flipped'])]);
			for (const id of flipped)
				ok(!(await holds(B, 'Flipped', [id])), `premise: ${id} stays on A while Flipped does not replicate`);

			const mark = await logMark(C);
			await deploy(A, true, true);
			await deploy(B, true, true);
			await waitForRows(B, 'Flipped', flipped);
			await deploy(C, true, true);
			await waitForRows(C, 'Flipped', flipped);
			ok(
				(await logSince(C, mark)).includes(`Route table scope widened for ${B.hostname} on database data`),
				'C requested the copy because the table scope widened'
			);
		});
	}
);
