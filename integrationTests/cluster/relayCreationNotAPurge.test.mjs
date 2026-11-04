/**
 * A relay's creation is not a purge of the relayed logs it holds.
 *
 * Chain A — B — C on `data` (`add_node` B→A and C→B, no A–C link). A writes before B's database exists, and A
 * stops before C joins, so no origin certificate ever raises C's resume cursor for A. That cursor stays at A's
 * last key, older than B. Nothing is purged, yet comparing the cursor with B's creation time forced a full copy
 * on every reconnect, and the copy could not move the cursor, so the next reconnect forced another.
 *
 * With a retention of seconds, B's log for A really is purged. C held all of it, so that forces nothing either. A
 * write of A's that C missed and B then purged does force the copy that carries it.
 *
 * The oracle is B's forced-copy log line. Each start of a node gets its own log, so each read covers the current
 * process from its start, and `subscription to` shows that process served C.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startHarper, killHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, stopNodeProcess, waitForCondition, readLog } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const TABLE = 'relay_epoch';
const FORCED_COPY = 'forcing a bounded base-copy resync';
const SEED_ROWS = Array.from({ length: 10 }, (_, i) => `a-${i}`);
const RELAY_RESTARTS = 3;

function chain(ctx, auditRetention) {
	const nodes = {};

	const options = (node) => ({
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true, level: 'debug', ...auditRetention },
			replication: { port: node.hostname + ':9933', securePort: null, databases: ['data'] },
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true },
	});

	async function start(node) {
		const started = (await startHarper({ name: ctx.name, harper: node }, options(node))).harper;
		return Object.assign(node, started);
	}

	// the pid file's process too: one killed seconds after it started can outlive the spawned handle
	async function stop(node) {
		await killHarper({ harper: node });
		await stopNodeProcess(node);
	}

	async function create(name) {
		const node = await start({ hostname: await getNextAvailableLoopbackAddress() });
		nodes[name] = node;
		await sendOperation(node, { operation: 'create_table', database: 'data', table: TABLE, primary_key: 'id' });
		return node;
	}

	const addNode = (node, to) =>
		sendOperation(node, {
			operation: 'add_node',
			hostname: to.hostname,
			rejectUnauthorized: false,
			authorization: to.admin,
		});

	const upsert = (node, ...ids) =>
		sendOperation(node, {
			operation: 'upsert',
			database: 'data',
			table: TABLE,
			records: ids.map((id) => ({ id, tag: id })),
		});

	const arrive = (node, ...ids) =>
		waitForCondition(
			async (signal) =>
				(
					await sendOperation(
						node,
						{ operation: 'search_by_id', database: 'data', table: TABLE, ids, get_attributes: ['id'] },
						{ signal }
					)
				).length === ids.length,
			{ timeoutMs: 120_000, description: `${ids.join(', ')} on ${node.hostname}` }
		);

	const forcedCopies = async (from, to) =>
		(await readLog(from))
			.split('\n')
			.filter((line) => line.includes(FORCED_COPY) && line.includes(`Peer ${to.hostname} `));

	const expectNoForcedCopy = async (from, to) => {
		const log = await readLog(from);
		ok(log.includes('subscription to'), 'the log read is of the process that served the follower');
		const forced = await forcedCopies(from, to);
		equal(forced.length, 0, `${from.hostname} forced a copy for ${to.hostname}:\n${forced.join('\n')}`);
	};

	async function restartFollower(id) {
		const { B, C } = nodes;
		await stop(C);
		await start(C);
		await upsert(B, id);
		await arrive(C, id);
		await expectNoForcedCopy(B, C);
	}

	async function restartRelay(id) {
		const { B, C } = nodes;
		await stop(B);
		await start(B);
		await upsert(B, id);
		await arrive(C, id);
		await expectNoForcedCopy(B, C);
	}

	const segmentsOfLog = async (node, logName) => {
		const files = await readdir(join(node.dataRootDir, 'database', 'data', 'transaction_logs', logName));
		return files.filter((file) => file.endsWith('.txnlog'));
	};

	const logPurged = (node, logName) =>
		waitForCondition(async () => (await segmentsOfLog(node, logName)).length === 0, {
			timeoutMs: 180_000,
			description: `${logName}'s log purged on ${node.hostname}`,
		});

	async function build() {
		const A = await create('A');
		await upsert(A, ...SEED_ROWS);
		const B = await create('B');
		await addNode(B, A);
		await arrive(B, ...SEED_ROWS);
		await stop(A);
		const C = await create('C');
		await addNode(C, B);
		await arrive(C, ...SEED_ROWS);
	}

	return { nodes, start, stop, upsert, arrive, forcedCopies, restartFollower, restartRelay, logPurged, build };
}

suite('a relay younger than the follower cursor it serves', { timeout: 900_000 }, (ctx) => {
	const { nodes, restartFollower, restartRelay, build } = chain(ctx);

	before(build);
	after(() => stopAndTeardownNodes(Object.values(nodes)));

	test('forces no copy when the follower restarts', () => restartFollower('after-follower-restart'));

	for (let restart = 1; restart <= RELAY_RESTARTS; restart++) {
		test(`forces no copy when the relay restarts (${restart} of ${RELAY_RESTARTS})`, () =>
			restartRelay(`after-relay-restart-${restart}`));
	}
});

const RETENTION = { auditRetention: 40 };

suite('a relayed log the relay purged after the follower held it', { timeout: 600_000 }, (ctx) => {
	const { nodes, restartFollower, restartRelay, logPurged, build } = chain(ctx, RETENTION);

	before(build);
	after(() => stopAndTeardownNodes(Object.values(nodes)));

	test('forces no copy', async () => {
		await logPurged(nodes.B, nodes.A.hostname);
		await restartFollower('after-purge-follower-restart');
		await restartRelay('after-purge-relay-restart');
	});
});

// B writes nothing of its own here, so only its log for A can force the copy
suite('a relayed log the relay purged before the follower received all of it', { timeout: 600_000 }, (ctx) => {
	const { nodes, start, stop, upsert, arrive, forcedCopies, logPurged, build } = chain(ctx, RETENTION);

	before(build);
	after(() => stopAndTeardownNodes(Object.values(nodes)));

	test('forces the copy that carries the write', async () => {
		const { A, B, C } = nodes;
		await stop(C);
		await start(A);
		await upsert(A, 'missed');
		await arrive(B, 'missed');
		await stop(A);
		await logPurged(B, A.hostname);
		await start(C);
		await arrive(C, 'missed');
		const forced = await forcedCopies(B, C);
		ok(
			forced.some((line) => line.includes(`whose log ${A.hostname} `)),
			`B forced the copy for its log for A:\n${forced.join('\n')}`
		);
	});
});
