/**
 * Removed and relayed origins resume from per-origin cursors (harper-pro#989).
 *
 * An origin a subscription neither lists nor excludes — a node removed with `remove_node`, or one that reaches
 * the subscriber only through a relay — had no cursor at all, so every resubscribe made the peer start that
 * origin's log at 0 and resend all of it, and a node added later pulled it from 0 in its copy's tail. A
 * subscriber now records, per peer, the highest origin log key it applied for every origin, sends those cursors
 * on its subscription request (`SUBSCRIPTION_REQUEST[4]`), and the peer starts each such origin
 * `ORIGIN_CURSOR_OVERLAP_MS` below its cursor. A base copy resumes every relayed log in append order past the
 * key it held when the copy began, and the receiver keeps those keys as its cursors.
 *
 * Topology, all on `data` (`databases: ['data']`, so membership is per node):
 *
 *   A ─ B        A, B and R are a full mesh; Q replicates only with A, so Q reaches B only through A.
 *   │ ╲ │
 *   Q   R
 *
 *   1. R and Q write OLD rows; then, after more than the overlap window, MID rows.
 *   2. B stops. R writes LATE rows, which reach A only.
 *   3. A and then B remove R; R is killed (A's removal already disabled it).
 *   4. B removes R: LATE must reach B through A without a restart, and without OLD. B then restarts:
 *      no peer may resend OLD (R's, or Q's through A).
 *   5. N joins A, then B, by base copy: neither copy's tail may carry OLD, and a restart of N must not either.
 *   6. A restarts: no OLD is resent, and R's log on A and B does not grow from step 4 on.
 *
 * The replay oracle is the SENDER's debug line `wrote record <id> length: <n> remoteNode <peer>` (the level is pinned to
 * debug), read from a log mark onward; for a copy, only after its `Finished copy table <table> <peer>` line, since
 * the copy itself carries every row.
 * Audit reads establish visibility around removal; post-restart reads prove persistence, since a mapped log
 * can remain readable after its file is unlinked. These checks keep the no-replay oracle from passing on lost history.
 */
import { suite, test, before, after } from 'node:test';
import { ok, deepEqual } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { killHarper, startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const TABLE = 'removed_origin';
// `ORIGIN_CURSOR_OVERLAP_MS` in replicationConnection.ts, plus margin: OLD must sit below MID's cursor by more.
const OVERLAP_MS = 60_000;
const AGE_MARGIN_MS = 5_000;
const CONVERGE_TIMEOUT_MS = 90_000;
// a copy's tail and a resume's first pass follow at once; give them time to land in the sender's log
const SETTLE_MS = 3_000;

const ids = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
const filedUnder = (recordIds, log) => Object.fromEntries(recordIds.map((id) => [id, log]));
const rOld = ids('r-old', 20);
const qOld = ids('q-old', 10);
const rMid = ids('r-mid', 5);
const qMid = ids('q-mid', 5);
const rLate = ids('r-late', 5);
const aIds = ids('a', 5);
const bIds = ids('b', 5);
const ALL_IDS = [...rOld, ...qOld, ...rMid, ...qMid, ...rLate, ...aIds, ...bIds];
const isOld = (id) => id.startsWith('r-old-') || id.startsWith('q-old-');

const nodeOptions = (node) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true, level: 'debug' },
		replication: { port: node.hostname + ':9933', securePort: null, databases: ['data'] },
		originLogFixture: { package: join(TEST_DIR, 'fixture-origin-log') },
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true },
});

async function startNode(node) {
	const started = (await startHarper({ name: node.name, harper: node }, nodeOptions(node))).harper;
	return Object.assign(node, started);
}

async function restartNode(node) {
	const previousProcess = node.process;
	await killHarper({ harper: node });
	ok(previousProcess.exitCode !== null || previousProcess.signalCode !== null, 'the previous process exited');
	const restarted = await startNode(node);
	ok(restarted.process.pid !== previousProcess.pid, 'restart starts a new process');
	return restarted;
}

async function startNewNode(suiteName) {
	const nodeCtx = { name: suiteName, harper: { hostname: await getNextAvailableLoopbackAddress() } };
	await startHarper(nodeCtx, nodeOptions(nodeCtx.harper));
	const node = Object.assign(nodeCtx.harper, { name: nodeCtx.name });
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

const upsert = (node, records) =>
	sendOperation(node, {
		operation: 'upsert',
		database: 'data',
		table: TABLE,
		records: records.map((id) => ({ id })),
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

function waitForIds(node, expected, what) {
	let missing;
	return waitForCondition(
		async (signal) => {
			const held = await idsOn(node, signal);
			missing = expected.filter((id) => !held.has(id));
			return missing.length === 0;
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: () => `${what}: still missing ${JSON.stringify(missing)}` }
	);
}

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

// The harness gives each start of a node its own log directory when HARPER_INTEGRATION_TEST_LOG_DIR is set, so a
// mark names the file it measured.
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

const SENT = /wrote record (\S+) length: \S+ remoteNode (\S+)/g;
const idsSentIn = (log, receiver) => [
	...new Set([...log.matchAll(SENT)].filter(([, , to]) => to === receiver.hostname).map(([, id]) => id)),
];
const oldIdsSentIn = (log, receiver) => idsSentIn(log, receiver).filter(isOld);

async function oldIdsSent(sender, receiver, mark) {
	return oldIdsSentIn(await logSince(sender, mark), receiver);
}

/** Only the copy's tail counts: the copy itself carries every row. */
async function idsSentAfterCopy(sender, receiver, mark) {
	const copied = `Finished copy table ${TABLE} ${receiver.hostname}`;
	let log;
	await waitForCondition(async () => (log = await logSince(sender, mark)).includes(copied), {
		timeoutMs: CONVERGE_TIMEOUT_MS,
		description: `${sender.hostname} to finish copying to ${receiver.hostname}`,
	});
	await delay(SETTLE_MS);
	log = await logSince(sender, mark);
	return idsSentIn(log.slice(log.indexOf(copied)), receiver);
}

async function oldIdsSentAfterCopy(sender, receiver, mark) {
	return (await idsSentAfterCopy(sender, receiver, mark)).filter(isOld);
}

suite('Removed and relayed origins resume from per-origin cursors (harper-pro#989)', { timeout: 600_000 }, (ctx) => {
	before(async () => {
		[ctx.A, ctx.B, ctx.R, ctx.Q] = await Promise.all([0, 1, 2, 3].map(() => startNewNode(ctx.name)));
		const { A, B, R, Q } = ctx;
		const marks = new Map(await Promise.all([A, B, R, Q].map(async (node) => [node, await logMark(node)])));
		await addNode(A, B);
		await addNode(A, R);
		await addNode(B, R);
		await addNode(Q, A);
		// A row a node first receives in a base copy has no log entry there, so the node cannot relay it:
		// every subscription's initial copy must be done before any origin writes.
		const links = [
			[A, B],
			[A, R],
			[A, Q],
			[B, A],
			[B, R],
			[R, A],
			[R, B],
			[Q, A],
		];
		await Promise.all(
			links.map(([node, peer]) =>
				waitForCondition(
					async () => (await logSince(node, marks.get(node))).includes(`bulk copy complete from ${peer.hostname}`),
					{ timeoutMs: CONVERGE_TIMEOUT_MS, description: `${node.hostname} to finish its copy from ${peer.hostname}` }
				)
			)
		);
		await Promise.all([upsert(R, rOld), upsert(Q, qOld), upsert(A, aIds), upsert(B, bIds)]);
		await Promise.all(
			[A, B].map((node) => waitForIds(node, [...rOld, ...qOld, ...aIds, ...bIds], 'the cluster converges'))
		);
	});

	after(() => stopAndTeardownNodes([ctx.A, ctx.B, ctx.R, ctx.Q, ctx.N]));

	test("a survivor restart resends none of a removed or relayed origin's old rows, and late rows still arrive", async () => {
		const { A, B, R, Q } = ctx;
		// Every later cursor for R and Q sits above OLD by more than the overlap.
		await delay(OVERLAP_MS + AGE_MARGIN_MS);
		await Promise.all([upsert(R, rMid), upsert(Q, qMid)]);
		await Promise.all([A, B].map((node) => waitForIds(node, [...rMid, ...qMid], 'MID reaches A and B')));

		// B holds Q only through A, so its cursor for Q is one B recorded on its A connection.
		const qMidVersion = Math.max(...Object.values(await postToFixture(B, 'RecordVersions', { ids: qMid })));
		ctx.qMidVersion = qMidVersion;
		let bCursorsFromA;
		await waitForCondition(
			async () =>
				(bCursorsFromA = await postToFixture(B, 'OriginCursors', { peer: A.hostname }))[Q.hostname] >= qMidVersion,
			{
				timeoutMs: CONVERGE_TIMEOUT_MS,
				description: () => `B's persisted cursor for Q on its A row to cover MID: ${JSON.stringify(bCursorsFromA)}`,
			}
		);

		const bRetainedLogs = await postToFixture(B, 'RecordLogs', { ids: [...rOld, ...rMid] });
		deepEqual(
			bRetainedLogs,
			filedUnder([...rOld, ...rMid], R.hostname),
			'B holds OLD and MID audit entries under R before removal'
		);
		await killHarper({ harper: B });
		await upsert(R, rLate);
		await waitForIds(A, rLate, 'LATE reaches A while B is down');
		const aRetainedLogs = await postToFixture(A, 'RecordLogs', { ids: [...rOld, ...rMid, ...rLate] });
		deepEqual(
			aRetainedLogs,
			filedUnder([...rOld, ...rMid, ...rLate], R.hostname),
			'A holds OLD, MID and LATE audit entries under R before removal'
		);
		const rMembership = {
			operation: 'search_by_hash',
			database: 'system',
			table: 'hdb_nodes',
			hash_values: [R.hostname],
			get_attributes: ['name'],
		};
		deepEqual(await sendOperation(R, rMembership), [{ name: R.hostname }], 'R is a member before removal');

		// A's removal also disables R itself (remove_node_back), so R stops replicating to anyone.
		await sendOperation(A, { operation: 'remove_node', hostname: R.hostname });
		deepEqual(await sendOperation(R, rMembership), [], 'R confirms its reciprocal membership removal');
		deepEqual(
			await postToFixture(A, 'RecordLogs', { ids: [...rOld, ...rMid, ...rLate] }),
			aRetainedLogs,
			'removing R must preserve its retained audit entries on A'
		);
		deepEqual(
			await postToFixture(R, 'RecordLogs', { ids: [...rOld, ...rMid, ...rLate] }),
			filedUnder([...rOld, ...rMid, ...rLate], 'local'),
			"reciprocal removal must preserve R's own audit entries"
		);
		await killHarper({ harper: R });
		await startNode(B);
		// Removing R lifts its exclusion on B's subscription to A, which re-admits A's log for R live.
		const markIncludeA = await logMark(A);
		await sendOperation(B, { operation: 'remove_node', hostname: R.hostname });
		deepEqual(
			await postToFixture(B, 'RecordLogs', { ids: [...rOld, ...rMid] }),
			bRetainedLogs,
			'removing R must preserve its retained audit entries on B'
		);
		await waitForIds(B, rLate, 'LATE reaches B through A once B removes R, without a restart');
		await delay(SETTLE_MS);
		deepEqual(await oldIdsSent(A, B, markIncludeA), [], 'A must not send OLD rows when it re-admits R for B');

		const markA = await logMark(A);
		const markB = await logMark(B);
		await restartNode(B);
		await waitForIds(A, ALL_IDS, 'A holds every row');
		await upsert(A, ['a-after-b']);
		await waitForIds(B, ['a-after-b'], 'B resumes from A after its restart');
		await delay(SETTLE_MS);
		deepEqual(
			await postToFixture(B, 'RecordVersions', { ids: rLate }),
			await postToFixture(A, 'RecordVersions', { ids: rLate }),
			'B holds the versions of LATE that A does'
		);

		deepEqual(await oldIdsSent(A, B, markA), [], 'A must not resend OLD rows to B on its restart');
		deepEqual(await oldIdsSent(B, A, markB), [], 'B must not resend OLD rows to A when it returns');
		for (const node of [A, B]) {
			deepEqual(
				await postToFixture(node, 'RecordLogs', { ids: rOld }),
				filedUnder(rOld, R.hostname),
				`${node.hostname} must retain OLD audit entries through removal and B's restart`
			);
		}
		ctx.rLogCounts = {
			A: (await postToFixture(A, 'LogEntryCount', { log: R.hostname })).count,
			B: (await postToFixture(B, 'LogEntryCount', { log: R.hostname })).count,
		};
		for (const [name, count] of Object.entries(ctx.rLogCounts)) {
			ok(count >= rOld.length + rMid.length + rLate.length, `R's retained log on ${name} lost entries: ${count}`);
		}
	});

	test('a node added after the removal pulls none of the old rows in its copy tails, nor on restart', async () => {
		const { A, B, R, Q } = ctx;
		ctx.N = await startNewNode(ctx.name);
		const { N } = ctx;
		// One copy at a time, so each copy's tail is everything its sender sent after the copy.
		let markA = await logMark(A);
		await addNode(N, A);
		deepEqual(await oldIdsSentAfterCopy(A, N, markA), [], "A's copy tail to N must not carry OLD rows");
		// Two batches at Q's anchor key (as under concurrent multi-path relay) trip exactStartFailures 'duplicate',
		// degrading Q from append-order resume to the overlap floor.
		const qDup = ['q-dup-0', 'q-dup-1'];
		await postToFixture(B, 'OriginLogWrite', {
			ghost: Q.hostname,
			version: ctx.qMidVersion + 1,
			records: qDup.map((id) => ({ id, fromGhost: true })),
		});
		const markB = await logMark(B);
		await addNode(N, B);
		const bTailIds = await idsSentAfterCopy(B, N, markB);
		deepEqual(bTailIds.filter(isOld), [], "B's copy tail to N must not carry OLD rows");
		ok(
			qMid.every((id) => bTailIds.includes(id)),
			`B's degraded copy tail to N must replay Q's overlap window below its anchor, got ${JSON.stringify(bTailIds)}`
		);
		ok(
			(await logSince(B, markB)).includes(`could not resume relayed log(s) ${Q.hostname} in append order`),
			"B must warn when Q's relayed log degrades from exact append-order resume to the overlap floor"
		);
		await waitForIds(N, [...ALL_IDS, ...qDup], 'N holds every row, LATE included');
		await delay(SETTLE_MS);
		// A copy writes a log entry for a row keyed at or after its anchor, so this is a baseline, not zero.
		const nRLogCount = (await postToFixture(N, 'LogEntryCount', { log: R.hostname })).count;

		// The copy's anchors are N's cursors: a restart must not pull R from 0 either.
		markA = await logMark(A);
		const markBAgain = await logMark(B);
		const markN = await logMark(N);
		await restartNode(N);
		await upsert(A, ['a-after-n']);
		await waitForIds(N, ['a-after-n'], 'N resumes after its restart');
		await delay(SETTLE_MS);
		deepEqual(await oldIdsSent(A, N, markA), [], 'A must not resend OLD rows to N on its restart');
		deepEqual(await oldIdsSent(B, N, markBAgain), [], 'B must not resend OLD rows to N on its restart');
		deepEqual(await oldIdsSent(N, A, markN), [], 'N must not send OLD rows back to A');
		deepEqual(await oldIdsSent(N, B, markN), [], 'N must not send OLD rows back to B');
		// N holds R's rows by copy, with no log entry to recognize a resend by, so the overlap window's rows are
		// appended once; nothing older is.
		const nRLogGrowth = (await postToFixture(N, 'LogEntryCount', { log: R.hostname })).count - nRLogCount;
		ok(
			nRLogGrowth <= rMid.length + rLate.length,
			`N's log for R may grow by the overlap window's rows only, grew by ${nRLogGrowth}`
		);
	});

	test("another survivor restart leaves the removed origin's log unchanged", async () => {
		const { A, B, R } = ctx;
		const markA = await logMark(A);
		const markB = await logMark(B);
		await restartNode(A);
		await upsert(B, ['b-after']);
		await waitForIds(A, ['b-after'], 'A resumes from B after its restart');
		await delay(SETTLE_MS);

		deepEqual(await oldIdsSent(B, A, markB), [], 'B must not resend OLD rows to A on its restart');
		deepEqual(await oldIdsSent(A, B, markA), [], 'A must not resend OLD rows to B when it returns');
		for (const node of [A, B]) {
			deepEqual(
				await postToFixture(node, 'RecordLogs', { ids: rOld }),
				filedUnder(rOld, R.hostname),
				'survivors must retain OLD audit entries through restarts and a new node joining'
			);
		}
		deepEqual(
			{
				A: (await postToFixture(A, 'LogEntryCount', { log: R.hostname })).count,
				B: (await postToFixture(B, 'LogEntryCount', { log: R.hostname })).count,
			},
			ctx.rLogCounts,
			"R's log on the survivors must not grow"
		);
	});
});
