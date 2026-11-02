/**
 * A base copy applied before a database generation recorded copy bounds is fenced at the first level-2 run
 * (harper-pro#1218).
 *
 *   A ─ Q ─ B   A writes; Q relays A to B; both A and Q certify at level 2 throughout. B joins Q on an engine
 *               without `syncWal` (rocksdb-js before 2.13.0), so its join copy writes A's rows with no audit
 *               entries and no copy bound, then restarts with `syncWal`.
 *
 * A transaction A holds open pins A's floor below a row the join copy wrote. Q's copy anchors A's log after that
 * row, so B holds it with no audit entry, and after B's upgrade a relayed floor-only resume would start below it
 * and skip it as a leading duplicate. B's route must not certify A from there (without the fence it does, and would
 * relay that claim onward). Once A's floor passes the fence, B certifies A again.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal, deepEqual } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
const STANDIN_SYNC_WAL = join(TEST_DIR, 'fixture-origin-log', 'standinSyncWal.mjs');
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const TABLE = 'checkpoint_origin';
const FLOOR_INTERVAL_MS = 5_000;
const CONVERGE_TIMEOUT_MS = 120_000;
// the fence reaches a minute past the upgrade (`COPY_BOUND_HEADROOM_MS`), plus a certificate round
const FENCE_PASS_TIMEOUT_MS = 180_000;
const WITHOUT_SYNC_WAL = { HARPER_TEST_WITHOUT_SYNC_WAL: '1' };

const nodeOptions = (node, env = {}) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true, level: 'debug' },
		replication: { port: node.hostname + ':9933', securePort: null, databases: ['data'] },
		// A's held transaction must outlast the upgrade and the wait for the fence (the default aborts it after 30 s)
		storage: { maxTransactionOpenTime: 600_000 },
		originLogFixture: { package: join(TEST_DIR, 'fixture-origin-log') },
	},
	env: {
		HARPER_NO_FLUSH_ON_EXIT: true,
		HARPER_TEST_ORIGIN_FLOOR_INTERVAL_MS: String(FLOOR_INTERVAL_MS),
		NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${STANDIN_SYNC_WAL}`].filter(Boolean).join(' '),
		...env,
	},
});

async function startNewNode(suiteName, testEnv) {
	const nodeCtx = { name: suiteName, harper: { hostname: await getNextAvailableLoopbackAddress(), testEnv } };
	await startHarper(nodeCtx, nodeOptions(nodeCtx.harper, testEnv));
	return Object.assign(nodeCtx.harper, { testEnv, name: nodeCtx.name });
}

async function restartNode(node) {
	await stopNodeProcess(node);
	const started = (await startHarper({ name: node.name, harper: node }, nodeOptions(node, node.testEnv))).harper;
	return Object.assign(node, started);
}

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

// a node holds no log for an origin whose rows reached it only by copy, so the fixture keys that origin's state by its
// local id: on B's row for Q, it is the one entry that is neither Q nor B
async function stateFor(node, peer, origin) {
	const { nodes } = await postToFixture(node, 'ClosedFloors', { peer: peer.hostname });
	if (nodes[origin.hostname]) return nodes[origin.hostname];
	const unnamed = Object.keys(nodes).filter((key) => ![peer.hostname, node.hostname, 'local', '0'].includes(key));
	return unnamed.length === 1 && origin !== peer && origin !== node ? nodes[unnamed[0]] : null;
}

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

const waitForState = (node, peer, origin, predicate, what, timeoutMs = CONVERGE_TIMEOUT_MS) =>
	waitForCondition(async () => predicate(await stateFor(node, peer, origin)), {
		timeoutMs,
		description: `${node.hostname}'s state for ${origin.hostname} via ${peer.hostname}: ${what}`,
	});

const checkpointGrade = (state) =>
	state?.closedFloor > 0 && typeof state.originGeneration === 'string' && state.fullCoverage === true;

async function linkAndCopy(node, peer) {
	const marks = new Map(await Promise.all([node, peer].map(async (n) => [n, (await readText(logPath(n))).length])));
	await sendOperation(node, {
		operation: 'add_node',
		hostname: peer.hostname,
		rejectUnauthorized: false,
		authorization: peer.admin,
	});
	await Promise.all(
		[
			[node, peer],
			[peer, node],
		].map(([receiver, source]) =>
			waitForCondition(
				async () =>
					(await readText(logPath(receiver)))
						.slice(marks.get(receiver))
						.includes(`bulk copy complete from ${source.hostname}`),
				{
					timeoutMs: CONVERGE_TIMEOUT_MS,
					description: `${receiver.hostname} to finish its copy from ${source.hostname}`,
				}
			)
		)
	);
}

// a copy still running (or interrupted by a restart, and so run again) reserves bounds that void the node's certifications
const waitForCopiesSettled = (node) =>
	waitForCondition(
		async () => {
			const { rows, copyCursors } = await postToFixture(node, 'CopyBounds', {});
			return copyCursors === 0 && !rows.some((row) => row.key[1] === 'reserved');
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: `every copy into ${node.hostname} to settle` }
	);

const logPath = (node) => join(node.logDir ?? join(node.dataRootDir, 'log'), 'hdb.log');
const readText = (path) =>
	readFile(path, 'utf8').catch((error) => (error.code === 'ENOENT' ? '' : Promise.reject(error)));

const SUITE = 'A copy applied before level-2 certification is fenced at the upgrade (harper-pro#1218)';
suite(SUITE, { timeout: 900_000 }, (ctx) => {
	before(async () => {
		[ctx.A, ctx.Q] = await Promise.all([startNewNode(ctx.name), startNewNode(ctx.name)]);
		await linkAndCopy(ctx.A, ctx.Q);
	});

	after(async () => {
		if (ctx.A) await postToFixture(ctx.A, 'ReleaseTransaction', {}).catch(() => {});
		await stopAndTeardownNodes([ctx.A, ctx.Q, ctx.B].filter(Boolean));
	});

	test('an upgraded node certifies no route across its pre-upgrade copy', async () => {
		const { A, Q } = ctx;
		// A's log must reach below the held key, or a floor-only resume below it predates A's history and A copies instead
		await upsert(A, 'seed');
		await waitForRecord(Q, 'seed');
		await postToFixture(A, 'HoldTransaction', { id: 'held' });
		// the floor cannot pass the held transaction's reservation, which is below every write that follows
		await new Promise((resolve) => setTimeout(resolve, 2 * FLOOR_INTERVAL_MS));
		await upsert(A, 'copied');
		const copiedVersion = (await postToFixture(A, 'RecordVersions', { ids: ['copied'] })).copied;
		await waitForRecord(Q, 'copied');

		ctx.B = await startNewNode(ctx.name, WITHOUT_SYNC_WAL);
		const { B } = ctx;
		// a peer with an empty log leaves Q no cursor for it, so each reconnect would copy from B again and void Q's
		// certification of A
		await upsert(B, 'b-seed');
		await linkAndCopy(Q, B);
		// Q's own copy from B voids Q's certifications, so Q resumes floor-only again to relay A at level 2
		await waitForCopiesSettled(Q);
		// a copy B has not finalized resumes after B's upgrade and, now recording bounds, would cover the copied row itself
		await waitForCopiesSettled(B);
		// When B's copy from Q finished first, Q's copy back from B bounds A at `copied`, which Q already holds with its
		// audit entry; that bound would keep Q from certifying A while the floor is held, so drop Q's settled bounds
		await postToFixture(Q, 'CopyBounds', { clearSettled: true });
		await waitForState(Q, A, A, checkpointGrade, 'a checkpoint-grade certificate from A on Q');
		await restartNode(Q);
		await waitForState(Q, A, A, (state) => state?.certifiedFrom > 0, "Q's route to A marked certified-from");
		await waitForRecord(B, 'copied');
		equal(
			(await postToFixture(B, 'RecordLogs', { ids: ['copied'] })).copied,
			undefined,
			"the join copy wrote the row with no audit entry in B's log"
		);
		const beforeUpgrade = await postToFixture(B, 'CopyBounds', {});
		equal(beforeUpgrade.rows.length, 0, 'an engine without syncWal records no copy bound');
		equal((await stateFor(B, Q, A))?.originGeneration ?? null, null, 'B certifies at level 1 before the upgrade');

		B.testEnv = undefined;
		await restartNode(B);
		await waitForState(B, Q, A, checkpointGrade, "A's certificate relayed through Q after the upgrade");
		await waitForState(B, Q, Q, checkpointGrade, "Q's own certificate after the upgrade");
		const heldFloor = (await stateFor(B, Q, A)).closedFloor;
		ok(heldFloor < copiedVersion, `A's floor ${heldFloor} is held below the copied row ${copiedVersion}`);

		// floor-only resume: without the fence, B would start just below the held floor and certify across the copy
		await restartNode(B);
		const logKeyBefore = (await stateFor(B, Q, A))?.originLogKey ?? 0;
		await upsert(A, 'after-floor-only-resume');
		await waitForRecord(B, 'after-floor-only-resume');
		await waitForState(
			B,
			Q,
			A,
			(state) => (state?.originLogKey ?? 0) > logKeyBefore,
			"B's row for A to persist the post-restart resume batch"
		);
		const resumed = await stateFor(B, Q, A);
		ok(
			resumed.certifiedFrom === null || resumed.certifiedFrom > copiedVersion,
			`B's route certified A from ${resumed.certifiedFrom}, at or below the copied row ${copiedVersion}`
		);

		const { rows, generation } = await postToFixture(B, 'CopyBounds', {});
		const fence = rows.find((row) => row.key[1] === 'fence' && row.key[2] === generation);
		ok(fence, `the upgrade wrote a fence for the database generation: ${JSON.stringify(rows)}`);
		deepEqual((await postToFixture(B, 'CopyBounds', {})).marker, { bounded: true });
		// Q's database was created at runtime by its first copy, so the next start must not fence its history
		deepEqual((await postToFixture(Q, 'CopyBounds', {})).marker, { bounded: false }, 'Q is marked without a fence');
		const fenceValues = Object.values(fence.bounds);
		// own, Q and A (keyed by id: B holds no log for A)
		equal(fenceValues.length, 3, `every known origin is fenced: ${JSON.stringify(fence.bounds)}`);
		ok(
			fenceValues.every((bound) => bound === fence.bounds.own && bound > copiedVersion),
			'one fence above the copied row'
		);

		// the fence is a lower limit, not a block: once A's floor passes it, a floor-only resume certifies again
		await postToFixture(A, 'ReleaseTransaction', {});
		await waitForRecord(B, 'held');
		await upsert(A, 'past-fence');
		await waitForRecord(B, 'past-fence');
		await waitForState(
			B,
			Q,
			A,
			(state) => state?.closedFloor > fence.bounds.own,
			"A's floor on B to pass the fence",
			FENCE_PASS_TIMEOUT_MS
		);
		await restartNode(B);
		await waitForState(
			B,
			Q,
			A,
			(state) => state?.certifiedFrom > fence.bounds.own,
			"B's route to certify A from above the fence"
		);
	});
});
