/**
 * An origin idle past auditRetention resumes without a forced base copy, also through a relay (harper-pro#1229).
 *
 * Topology, all on `data`:
 *
 *   A ─ B ─ C      A writes; B relays A to C and C to A; B and C never write (empty local logs).
 *
 * Retention is seconds, so an idle interval longer than retention fits in one test. In the first test no write
 * moves a follower's resume position during it; in the second B keeps writing while A stays idle, so B's log is
 * purged past A's on the same sender. The sender's oracle lines are its `forcing a bounded base-copy resync` warning and
 * `Replicating all tables to <peer>`; the positive evidence after a restart is a later write arriving on the
 * restarted node. Before the fix every restart below forced a full copy, comparing the start with
 * `now - auditRetention`.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { killHarper, startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const TABLE = 'idle_origin';
const RETENTION_S = 45;
// past retention plus two cleanup passes (the RocksDB pass runs at least every 10 s)
const IDLE_MS = (RETENTION_S + 25) * 1000;
const CONVERGE_TIMEOUT_MS = 90_000;
const FORCED_COPY = 'forcing a bounded base-copy resync';

const nodeOptions = (node) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true, level: 'debug', auditRetention: RETENTION_S },
		replication: { port: node.hostname + ':9933', securePort: null, databases: ['data'] },
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true },
});

async function startNode(node) {
	const started = (await startHarper({ name: node.name, harper: node }, nodeOptions(node))).harper;
	return Object.assign(node, started);
}

async function restartNode(node) {
	await killHarper({ harper: node });
	await stopNodeProcess(node);
	return startNode(node);
}

async function startNewNode(suiteName) {
	const nodeCtx = { name: suiteName, harper: { hostname: await getNextAvailableLoopbackAddress() } };
	await startHarper(nodeCtx, nodeOptions(nodeCtx.harper));
	const node = Object.assign(nodeCtx.harper, { name: nodeCtx.name });
	await sendOperation(node, { operation: 'create_table', database: 'data', table: TABLE, primary_key: 'id' });
	return node;
}

const addNode = (node, peer) =>
	sendOperation(node, {
		operation: 'add_node',
		hostname: peer.hostname,
		rejectUnauthorized: false,
		authorization: peer.admin,
	});

const upsert = (node, id) =>
	sendOperation(node, { operation: 'upsert', database: 'data', table: TABLE, records: [{ id }] });

async function hasRecord(node, id, signal) {
	const rows = await sendOperation(
		node,
		{ operation: 'search_by_id', database: 'data', table: TABLE, ids: [id], get_attributes: ['id'] },
		{ signal }
	);
	return rows.some((row) => row.id === id);
}

const waitForRecord = (node, id) =>
	waitForCondition((signal) => hasRecord(node, id, signal), {
		timeoutMs: CONVERGE_TIMEOUT_MS,
		description: `${id} to reach ${node.hostname}`,
	});

const linesAbout = (log, node) => log.split('\n').filter((line) => line.includes(node.hostname));
const logPath = (node) => join(node.logDir ?? join(node.dataRootDir, 'log'), 'hdb.log');
const readText = (path) =>
	readFile(path, 'utf8').catch((error) => (error.code === 'ENOENT' ? '' : Promise.reject(error)));
async function logMark(node) {
	const path = logPath(node);
	return { path, length: (await readText(path)).length };
}
async function logSince(node, mark) {
	const text = (await readText(mark.path)).slice(mark.length);
	return logPath(node) === mark.path ? text : text + (await readText(logPath(node)));
}

suite('Idle origins resume without a forced copy (harper-pro#1229)', { timeout: 900_000 }, (ctx) => {
	before(async () => {
		[ctx.A, ctx.B, ctx.C] = await Promise.all([startNewNode(ctx.name), startNewNode(ctx.name), startNewNode(ctx.name)]);
		const { A, B, C } = ctx;
		const marks = new Map(await Promise.all([A, B, C].map(async (node) => [node, await logMark(node)])));
		await addNode(A, B);
		await addNode(B, C);
		const links = [
			[A, B],
			[B, A],
			[B, C],
			[C, B],
		];
		await Promise.all(
			links.map(([node, peer]) =>
				waitForCondition(
					async () => (await logSince(node, marks.get(node))).includes(`bulk copy complete from ${peer.hostname}`),
					{ timeoutMs: CONVERGE_TIMEOUT_MS, description: `${node.hostname} to finish its copy from ${peer.hostname}` }
				)
			)
		);
		await upsert(A, 'before-idle');
		await Promise.all([B, C].map((node) => waitForRecord(node, 'before-idle')));
	});

	after(() => stopAndTeardownNodes([ctx.A, ctx.B, ctx.C].filter(Boolean)));

	test('direct and relayed followers restart past retention and stream with no copy', async () => {
		const { A, B, C } = ctx;
		await delay(IDLE_MS);

		// every reconnect happens before the next write: a write would refresh every link's applied position
		const markA = await logMark(A);
		await restartNode(B);
		const markB = await logMark(B);
		await restartNode(C);
		await upsert(A, 'after-restarts');
		await Promise.all([B, C].map((node) => waitForRecord(node, 'after-restarts')));

		const logA = linesAbout(await logSince(A, markA), B);
		ok(!logA.some((line) => line.includes(FORCED_COPY)), `A forced a copy for B:\n${logA.join('\n')}`);
		ok(!logA.some((line) => line.includes('Replicating all tables to')), 'A copied everything to B again');
		const logB = linesAbout(await logSince(B, markB), C);
		ok(!logB.some((line) => line.includes(FORCED_COPY)), `B forced a copy for C:\n${logB.join('\n')}`);
		ok(!logB.some((line) => line.includes('Replicating all tables to')), 'B copied everything to C again');
		ok(!(await logSince(B, markB)).includes('Requesting full copy'), 'B asked for a full copy');
	});

	test('a relayed origin idle beside an active local log forces nothing', async () => {
		const { A, B, C } = ctx;
		const deadline = Date.now() + IDLE_MS;
		for (let i = 0; Date.now() < deadline; i++) {
			await upsert(B, `active-${i}`);
			await delay(5_000);
		}
		await upsert(B, 'last-active');
		await waitForRecord(C, 'last-active');
		const markB = await logMark(B);
		await restartNode(C);
		await upsert(A, 'after-active');
		await waitForRecord(C, 'after-active');
		const logB = linesAbout(await logSince(B, markB), C);
		ok(!logB.some((line) => line.includes(FORCED_COPY)), `B forced a copy for C:\n${logB.join('\n')}`);
		ok(!logB.some((line) => line.includes('Replicating all tables to')), 'B copied everything to C again');
	});
});
