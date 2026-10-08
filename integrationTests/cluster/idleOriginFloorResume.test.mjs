/**
 * Origin-closed floor certificates keep an idle origin's receivers on a proven resume point (harper-pro#922
 * item 2, closing harper-pro#989 defect B).
 *
 * A receiver's resume cursors used to move only on applied frames and the sender's position trailers, so a
 * connected origin that wrote nothing never advanced them; once a cursor was older than `auditRetention`, the
 * next reconnect was upgraded to a bounded base copy, on every reconnect for an idle sender. Now a sender
 * certifies, to a peer that advertises `originFloors`, the floor core closed for its own log and the relayable
 * floors it holds for the origins it relays; the receiver stores them beside its cursors and resumes from them.
 *
 * Topology, all on `data`:
 *
 *   E ─ A ─ B ─ C      A writes; B relays A to C and C to A; C and B never write (empty local logs).
 *                      E omits its capability bag (`HARPER_TEST_OMIT_REPLICATION_CAPABILITIES`), so A and E
 *                      exchange no floors and keep main's behaviour.
 *
 * Retention is seconds and the floor interval is shortened, so an idle interval longer than retention fits in
 * one test. The sender's oracle lines are its `forcing a bounded base-copy resync` warning and `Replicating all
 * tables to <peer>`; the positive evidence after a restart is a later write arriving on the restarted node.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { killHarper, startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const TABLE = 'idle_origin';
const RETENTION_S = 45;
// the core certifier ticks every 5 s; the sender interval is shortened to match
const FLOOR_INTERVAL_MS = 5_000;
const CONVERGE_TIMEOUT_MS = 90_000;
const FORCED_COPY = 'forcing a bounded base-copy resync';

const nodeOptions = (node, env = {}) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true, level: 'debug', auditRetention: RETENTION_S },
		replication: { port: node.hostname + ':9933', securePort: null, databases: ['data'] },
		originLogFixture: { package: join(TEST_DIR, 'fixture-origin-log') },
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_ORIGIN_FLOOR_INTERVAL_MS: String(FLOOR_INTERVAL_MS), ...env },
});

async function startNode(node) {
	const started = (await startHarper({ harper: node }, nodeOptions(node, node.testEnv))).harper;
	return Object.assign(node, started);
}

async function restartNode(node) {
	await killHarper({ harper: node });
	return startNode(node);
}

async function startNewNode(suiteName, testEnv) {
	const nodeCtx = { name: suiteName, harper: { hostname: await getNextAvailableLoopbackAddress(), testEnv } };
	await startHarper(nodeCtx, nodeOptions(nodeCtx.harper, testEnv));
	// the harness replaces the context's node object, and every restart must carry the same environment
	const node = Object.assign(nodeCtx.harper, { testEnv });
	await sendOperation(node, { operation: 'create_table', database: 'data', table: TABLE, primary_key: 'id' });
	// the fixture's resources register at boot, and a table created afterwards unregisters them
	return restartNode(node);
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

async function postToFixture(node, resource, body) {
	const response = await fetch(`${node.httpURL}/${resource}`, {
		signal: AbortSignal.timeout(10_000),
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
		},
		body: JSON.stringify({ table: TABLE, ...body }),
	});
	ok(response.ok, `${resource} on ${node.hostname}: ${response.status}`);
	return response.json();
}

const floorsOn = (node, peer) => postToFixture(node, 'ClosedFloors', { peer: peer.hostname });
const floorFor = async (node, peer, origin) => (await floorsOn(node, peer)).nodes[origin.hostname]?.closedFloor ?? null;
const ownFloor = async (node) => (await postToFixture(node, 'OriginFloor', {})).floor;

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

const waitForFloor = (node, peer, origin, above, what) =>
	waitForCondition(async () => (await floorFor(node, peer, origin)) > above, {
		timeoutMs: CONVERGE_TIMEOUT_MS,
		description: `${node.hostname}'s floor for ${origin.hostname} via ${peer.hostname} to pass ${above} (${what})`,
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

suite('Idle origins keep a certified resume floor (harper-pro#922)', { timeout: 900_000 }, (ctx) => {
	before(async () => {
		[ctx.A, ctx.B, ctx.C, ctx.E] = await Promise.all([
			startNewNode(ctx.name),
			startNewNode(ctx.name),
			startNewNode(ctx.name),
			startNewNode(ctx.name, { HARPER_TEST_OMIT_REPLICATION_CAPABILITIES: '1' }),
		]);
		const { A, B, C, E } = ctx;
		const marks = new Map(await Promise.all([A, B, C, E].map(async (node) => [node, await logMark(node)])));
		await addNode(A, B);
		await addNode(B, C);
		await addNode(A, E);
		const links = [
			[A, B],
			[B, A],
			[B, C],
			[C, B],
			[A, E],
			[E, A],
		];
		await Promise.all(
			links.map(([node, peer]) =>
				waitForCondition(
					async () => (await logSince(node, marks.get(node))).includes(`bulk copy complete from ${peer.hostname}`),
					{ timeoutMs: CONVERGE_TIMEOUT_MS, description: `${node.hostname} to finish its copy from ${peer.hostname}` }
				)
			)
		);
		await upsert(A, 'seed');
		await Promise.all([waitForRecord(B, 'seed'), waitForRecord(C, 'seed'), waitForRecord(E, 'seed')]);
		ctx.lastWriteAt = Date.now();
	});

	after(async () => {
		await stopAndTeardownNodes([ctx.A, ctx.B, ctx.C, ctx.E].filter(Boolean));
	});

	test('certifies an idle origin to its direct peer and one hop beyond, never to a peer without the capability', async () => {
		const { A, B, C, E } = ctx;
		await waitForFloor(B, A, A, 0, 'first certificate');
		const first = await floorsOn(B, A);
		const firstFloor = first.nodes[A.hostname].closedFloor;
		equal(first.nodes[A.hostname].relayable, true, 'B receives A directly with full coverage');
		ok(firstFloor <= (await ownFloor(A)), 'a floor never passes the one the origin persisted');
		await waitForFloor(B, A, A, firstFloor, 'the floor keeps advancing while A writes nothing');
		ok((await floorFor(B, A, A)) <= (await ownFloor(A)));

		// one hop: B forwards A's floor to C from its direct row, and C stores it as not relayable
		await waitForFloor(C, B, A, 0, "A's floor relayed through B");
		const onC = await floorsOn(C, B);
		equal(onC.nodes[A.hostname].relayable, false, 'C does not receive A directly');
		ok(onC.nodes[A.hostname].closedFloor <= (await floorFor(B, A, A)), "C's floor for A never passes B's");
		equal(onC.nodes[B.hostname].relayable, true, "B's own floor is relayable on C");
		ok(onC.nodes[B.hostname].closedFloor > 0, 'an origin with an empty log still certifies');
		equal(onC.nodes[C.hostname]?.closedFloor ?? null, null, "a node's own floor is not a certificate for it");

		// capability-off: nothing is stored on either side of the A–E link
		await delay(3 * FLOOR_INTERVAL_MS);
		equal(await floorFor(A, E, E), null, 'E omits its bag, so A certifies nothing to it');
		equal(await floorFor(E, A, A), null, 'A rejects floors from a peer that advertised no capability');
	});

	test('a long transaction holds the floor without delaying other writes', async () => {
		const { A, B } = ctx;
		await postToFixture(A, 'HoldTransaction', { id: 'held' });
		await upsert(A, 'after-held');
		await waitForRecord(B, 'after-held');
		// the floor may still climb to the held transaction's key (certified every 5 s), then it stops there
		await delay(2 * FLOOR_INTERVAL_MS);
		const heldFloor = await ownFloor(A);
		await delay(2 * FLOOR_INTERVAL_MS);
		equal(await ownFloor(A), heldFloor, "A's floor stays at the held transaction's reservation");
		ok((await floorFor(B, A, A)) <= heldFloor, "B's floor for A is held with it");
		ok(!(await hasRecord(B, 'held')), 'the held write has not committed');
		await postToFixture(A, 'ReleaseTransaction', {});
		await waitForRecord(B, 'held');
		await waitForFloor(B, A, A, heldFloor, 'the floor advances once the transaction commits');
		ctx.lastWriteAt = Date.now();
	});

	test('reconnects after an idle interval longer than retention resume incrementally', async () => {
		const { A, B, C, E } = ctx;
		// past the retention cutoff for the last write, with certified floors newer than that cutoff
		const cutoff = ctx.lastWriteAt + RETENTION_S * 1000 + 2 * FLOOR_INTERVAL_MS;
		await delay(Math.max(0, cutoff - Date.now()));
		await waitForFloor(B, A, A, cutoff - 2 * FLOOR_INTERVAL_MS, 'a floor past the cutoff');
		await waitForFloor(C, B, A, cutoff - 2 * FLOOR_INTERVAL_MS, "C's floor for A past the cutoff");
		await waitForFloor(C, B, B, cutoff - 2 * FLOOR_INTERVAL_MS, "C's floor for B past the cutoff");

		// every reconnect happens before the next write: a write would refresh every link's applied position
		const markA = await logMark(A);
		await restartNode(B);
		const markB = await logMark(B);
		await restartNode(C);
		await restartNode(E);
		// without the capability the idle link aged past retention, so its reconnect is a base copy, as before
		await waitForCondition(
			async () => linesAbout(await logSince(A, markA), E).some((line) => line.includes(FORCED_COPY)),
			{ timeoutMs: CONVERGE_TIMEOUT_MS, description: 'A to force a base copy for the peer without the capability' }
		);
		await upsert(A, 'after-restarts');
		await Promise.all([B, C, E].map((node) => waitForRecord(node, 'after-restarts')));

		const logA = linesAbout(await logSince(A, markA), B);
		ok(!logA.some((line) => line.includes(FORCED_COPY)), `A forced a copy for B:\n${logA.join('\n')}`);
		ok(!logA.some((line) => line.includes('Replicating all tables to')), 'A copied everything to B again');
		const logB = linesAbout(await logSince(B, markB), C);
		ok(!logB.some((line) => line.includes(FORCED_COPY)), `B forced a copy for C:\n${logB.join('\n')}`);
		ok(!logB.some((line) => line.includes('Replicating all tables to')), 'B copied everything to C again');
		ok(!(await logSince(B, markB)).includes('Requesting full copy'), 'B asked for a full copy');
	});
});
