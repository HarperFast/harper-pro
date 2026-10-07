/**
 * An idle peer resumes incrementally past auditRetention (harper-pro#989).
 *
 * A peer with no new writes of its own sends its subscriber nothing, so the subscriber's cursor for it stops
 * moving. Once that cursor is older than `auditRetention`, the sender's retention check
 * (`shouldForceBaseCopyForRetention`) used to read it as purged history and force a base copy on the next
 * reconnect. rocksdb-js keeps a log's newest file past retention, so the entry the cursor names is still there,
 * and an incremental resume past it misses nothing; the sender now checks for that entry before forcing a copy.
 *
 * A peer whose log has no entry at all still takes the base copy: nothing proves nothing was purged
 * (harper-pro#922's closed floor is what would cover it; `retainedResumeRange` unit tests pin that). It is
 * not reproduced here, because whether a node's log stays empty depends on whether a copy wrote it a reload marker.
 *
 *   P ─ S     S subscribes to P. P writes once, then idles.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { killHarper, startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const TABLE = 'idle_peer';
const RETENTION_MS = 15_000;
const CONVERGE_TIMEOUT_MS = 90_000;

const nodeOptions = (node) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: {
			colors: false,
			stdStreams: false,
			console: true,
			level: 'debug',
			auditRetention: `${RETENTION_MS / 1000}s`,
		},
		replication: { port: node.hostname + ':9933', securePort: null, databases: ['data'] },
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true },
});

async function startNode(node) {
	const started = (await startHarper({ harper: node }, nodeOptions(node))).harper;
	return Object.assign(node, started);
}

async function startNewNode(suiteName) {
	const nodeCtx = { name: suiteName, harper: { hostname: await getNextAvailableLoopbackAddress() } };
	await startHarper(nodeCtx, nodeOptions(nodeCtx.harper));
	await sendOperation(nodeCtx.harper, {
		operation: 'create_table',
		database: 'data',
		table: TABLE,
		primary_key: 'id',
	});
	return nodeCtx.harper;
}

const addNode = (node, peer) =>
	sendOperation(node, {
		operation: 'add_node',
		hostname: peer.hostname,
		rejectUnauthorized: false,
		authorization: peer.admin,
	});

async function idsOn(node, signal) {
	const rows = await sendOperation(
		node,
		{
			operation: 'search_by_value',
			database: 'data',
			table: TABLE,
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id'],
		},
		{ signal }
	);
	return new Set(rows.map((row) => row.id));
}

const waitForId = (node, id) =>
	waitForCondition(async (signal) => (await idsOn(node, signal)).has(id), {
		timeoutMs: CONVERGE_TIMEOUT_MS,
		description: `${id} to reach ${node.hostname}`,
	});

// The harness gives each start of a node its own log directory when HARPER_INTEGRATION_TEST_LOG_DIR is set.
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

const forcedCopy = (log, subscriber) =>
	log.includes(`Peer ${subscriber.hostname} requested replication of database data from`) &&
	log.includes('forcing a bounded base-copy resync');
const incrementalPastRetention = (log, subscriber) =>
	log.includes(`Peer ${subscriber.hostname} resumes database data incrementally from`);

suite('An idle peer resumes incrementally past auditRetention (harper-pro#989)', { timeout: 300_000 }, (ctx) => {
	before(async () => {
		[ctx.P, ctx.S] = await Promise.all([0, 1].map(() => startNewNode(ctx.name)));
		const { P, S } = ctx;
		await addNode(S, P);
		await sendOperation(P, {
			operation: 'upsert',
			database: 'data',
			table: TABLE,
			records: [{ id: 'p-0' }, { id: 'p-1' }],
		});
		await waitForId(S, 'p-1');
	});

	after(() => stopAndTeardownNodes([ctx.P, ctx.S]));

	test('a subscriber reconnecting after the retention window resumes an idle peer without a base copy', async () => {
		const { P, S } = ctx;
		// Long enough for S's cursors to fall behind the cutoff and for P's retention pass to run.
		await delay(RETENTION_MS * 2);

		const markP = await logMark(P);
		await killHarper({ harper: S });
		await startNode(S);
		await sendOperation(P, { operation: 'upsert', database: 'data', table: TABLE, records: [{ id: 'p-live' }] });
		await waitForId(S, 'p-live');

		const logP = await logSince(P, markP);
		ok(!forcedCopy(logP, S), 'P must not force a base copy on S: its last entry is still retained');
		ok(incrementalPastRetention(logP, S), 'P must record that it resumed S past the retention cutoff');
	});
});
