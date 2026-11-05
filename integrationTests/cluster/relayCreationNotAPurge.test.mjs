/**
 * A relay's creation is not a purge of the relayed logs it holds.
 *
 * Chain A — B — C on `data` (`add_node` B→A and C→B, no A–C link). A writes before B's database exists, and A
 * stops before C joins, so no origin certificate ever raises C's resume cursor for A. That cursor stays at A's
 * last key, older than B. Nothing is purged, yet comparing the cursor with B's creation time forced a full copy
 * on every reconnect, and the copy could not move the cursor, so the next reconnect forced another.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, killHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, stopNodeProcess, waitForCondition, readLog } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const TABLE = 'relay_epoch';
const FORCED_COPY = 'forcing a bounded base-copy resync';
const SEED_ROWS = Array.from({ length: 10 }, (_, i) => `a-${i}`);
const RELAY_RESTARTS = 3;

function chain(ctx, auditRetention, env) {
	const nodes = {};
	let beforeSeed = 0;
	let beforeRelay = 0;

	const options = (node) => ({
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true, level: 'debug', ...auditRetention },
			replication: { port: node.hostname + ':9933', securePort: null, databases: ['data'] },
		},
		env,
	});

	async function start(node) {
		const started = (await startHarper({ name: ctx.name, harper: node }, options(node))).harper;
		return Object.assign(node, started);
	}

	// Also stop the process recorded in the pid file, because a node killed seconds after startup can outlive the child handle spawned by startHarper.
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

	const addNode = (node, to, extra) =>
		sendOperation(node, {
			operation: 'add_node',
			hostname: to.hostname,
			rejectUnauthorized: false,
			authorization: to.admin,
			...extra,
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

	async function lastDataSubscriptionCursors() {
		const { A, B, C } = nodes;
		const log = await readLog(C);
		const startMatches = [
			...log.matchAll(
				new RegExp(
					`Starting time recorded in db ${B.hostname.replaceAll('.', '\\.')} \\d+ data \\S+ start time: ([0-9.]+)`,
					'g'
				)
			),
		];
		ok(startMatches.length > 0, `C logged its data subscription start time for ${B.hostname}`);
		const lastStart = startMatches.at(-1);
		const startForB = Number(lastStart[1]);
		const cursorsLine = log.slice(lastStart.index).match(/per-origin resume cursors[^\n]*/)?.[0] ?? '';
		const cursorMatch = cursorsLine.match(new RegExp(`['"]?${A.hostname.replaceAll('.', '\\.')}['"]?:\\s*([0-9.]+)`));
		const cursorForA = cursorMatch ? Number(cursorMatch[1]) : undefined;
		return { cursorForA, startForB };
	}

	async function restartFollower(id) {
		const { B, C } = nodes;
		await stop(C);
		await start(C);
		await upsert(B, id);
		await arrive(C, id);
		const { cursorForA, startForB } = await lastDataSubscriptionCursors();
		ok(
			cursorForA > 0 && cursorForA < beforeRelay,
			`C resumed with cursor ${cursorForA} for A older than relay B (${beforeRelay})`
		);
		ok(
			startForB >= beforeRelay,
			`C resumed with start ${startForB} for B at or after relay B's creation (${beforeRelay})`
		);
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

	async function build({ joinFollower = true } = {}) {
		const A = await create('A');
		await delay(20);
		beforeSeed = Date.now();
		await delay(20);
		await upsert(A, ...SEED_ROWS);
		await delay(20);
		beforeRelay = Date.now();
		await delay(20);
		const B = await create('B');
		await addNode(B, A);
		await arrive(B, ...SEED_ROWS);
		await stop(A);
		const C = await create('C');
		if (joinFollower) {
			await addNode(C, B);
			await arrive(C, ...SEED_ROWS);
		}
	}

	return {
		nodes,
		getBeforeSeed: () => beforeSeed,
		getBeforeRelay: () => beforeRelay,
		start,
		stop,
		addNode,
		upsert,
		arrive,
		forcedCopies,
		lastDataSubscriptionCursors,
		restartFollower,
		restartRelay,
		logPurged,
		build,
	};
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

suite('a relayed log the relay purged before the follower received all of it', { timeout: 600_000 }, (ctx) => {
	const FLOOR_INTERVAL_MS = 2000;
	const { nodes, start, stop, upsert, arrive, forcedCopies, logPurged, build } = chain(ctx, RETENTION, {
		HARPER_TEST_ORIGIN_FLOOR_INTERVAL_MS: String(FLOOR_INTERVAL_MS),
	});

	before(build);
	after(() => stopAndTeardownNodes(Object.values(nodes)));

	test('forces the copy that carries the write', async () => {
		const { A, B, C } = nodes;
		// Wait for B to certify an origin floor so C's resume cursor for B advances past B's own last write;
		// when C reconnects, only the purge of B's log for A can force the copy.
		await delay(5 * FLOOR_INTERVAL_MS);
		await stop(C);
		await start(A);
		await upsert(A, 'missed');
		await arrive(B, 'missed');
		await stop(A);
		// Retention removes only flushed log segments, and a write that arrived as a plain frame waits for a
		// segment flush; stopping B flushes its open segment cleanly.
		await stop(B);
		await start(B);
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

suite(
	'a follower whose start on the relay predates where the relay began tracking purges',
	{ timeout: 600_000 },
	(ctx) => {
		const {
			nodes,
			getBeforeSeed,
			getBeforeRelay,
			start,
			stop,
			addNode,
			upsert,
			arrive,
			forcedCopies,
			lastDataSubscriptionCursors,
			build,
		} = chain(ctx, { auditRetention: 600_000 });

		before(() => build({ joinFollower: false }));
		after(() => stopAndTeardownNodes(Object.values(nodes)));

		test('forces one copy for the pre-tracking start and none once the follower start advances', async () => {
			const { B, C } = nodes;
			const beforeSeed = getBeforeSeed();
			const beforeRelay = getBeforeRelay();
			await addNode(C, B, { start_time: beforeSeed });
			await upsert(B, 'b-live');
			await arrive(C, ...SEED_ROWS, 'b-live');
			const initialCursors = await lastDataSubscriptionCursors();
			equal(initialCursors.startForB, beforeSeed, 'C requested replication of B starting before B existed');
			const forced = await forcedCopies(B, C);
			equal(forced.length, 1, `B forced one base copy for C's pre-tracking start:\n${forced.join('\n')}`);
			const trackedMatch = forced[0].match(
				/from before (\S+), where this node began accounting for its transaction-log history/
			);
			ok(trackedMatch, `B logged the predates-purge-tracking reason:\n${forced[0]}`);
			const trackedFrom = Date.parse(trackedMatch[1]);
			ok(beforeRelay < trackedFrom, `beforeRelay ${beforeRelay} predates B's trackedFrom ${trackedFrom}`);

			await stop(C);
			await start(C);
			await upsert(B, 'after-pretracking-copy');
			await arrive(C, 'after-pretracking-copy');
			const resumedCursors = await lastDataSubscriptionCursors();
			ok(
				resumedCursors.cursorForA > beforeSeed && resumedCursors.cursorForA < beforeRelay,
				`C's cursor ${resumedCursors.cursorForA} for A sits between beforeSeed ${beforeSeed} and beforeRelay ${beforeRelay} (< trackedFrom ${trackedFrom})`
			);
			ok(
				resumedCursors.startForB >= trackedFrom,
				`C's start ${resumedCursors.startForB} for B advanced to or past trackedFrom ${trackedFrom}`
			);
			equal(
				(await forcedCopies(B, C)).length,
				1,
				'B forced no second copy after C reconnected with cursor(A) < trackedFrom <= start(B)'
			);
		});
	}
);
