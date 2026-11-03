/**
 * Per-origin subscription checkpoints resume on another node without missing a delayed transaction
 * (harper-pro#922 items 3–4).
 *
 * Topology, all on `data`:
 *
 *   E ─ A ─ B ─ C      A writes; B relays A to C; C and B never write. E omits its capability bag, so the A–E
 *                      link stays on main's behaviour and E's rows carry no checkpoint-grade state.
 *
 * Level-2 certificates give B (direct) and C (one hop) a floor for A with A's database generation and full
 * coverage; a restart makes each resume floor-only and record where its complete prefix begins. A checkpoint
 * issued on C then names no origin (A, B and C are all healthy) and resumes on B, where a transaction A held
 * open across the checkpoint is delivered after the resume. An MQTT durable session does the same across a
 * reconnect to the other node.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal, deepEqual } from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import mqtt from 'mqtt';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
const STANDIN_SYNC_WAL = join(TEST_DIR, 'fixture-origin-log', 'standinSyncWal.mjs');
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const TABLE = 'checkpoint_origin';
const FLOOR_INTERVAL_MS = 5_000;
const CONVERGE_TIMEOUT_MS = 120_000;

const nodeOptions = (node, env = {}) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true, level: 'debug' },
		replication: { port: node.hostname + ':9933', securePort: null, databases: ['data'] },
		originLogFixture: { package: join(TEST_DIR, 'fixture-origin-log') },
	},
	env: {
		HARPER_NO_FLUSH_ON_EXIT: true,
		HARPER_TEST_ORIGIN_FLOOR_INTERVAL_MS: String(FLOOR_INTERVAL_MS),
		NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${STANDIN_SYNC_WAL}`].filter(Boolean).join(' '),
		...env,
	},
});

async function startNode(node) {
	const started = (await startHarper({ name: node.name, harper: node }, nodeOptions(node, node.testEnv))).harper;
	return Object.assign(node, started);
}

async function restartNode(node) {
	await stopNodeProcess(node);
	return startNode(node);
}

async function startNewNode(suiteName, testEnv) {
	const nodeCtx = { name: suiteName, harper: { hostname: await getNextAvailableLoopbackAddress(), testEnv } };
	await startHarper(nodeCtx, nodeOptions(nodeCtx.harper, testEnv));
	return Object.assign(nodeCtx.harper, { testEnv, name: nodeCtx.name });
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

const floorsOn = (node, peer, options) => postToFixture(node, 'ClosedFloors', { peer: peer.hostname, ...options });
const stateFor = async (node, peer, origin) => (await floorsOn(node, peer)).nodes[origin.hostname] ?? null;
const subscription = (node, body) => postToFixture(node, 'CheckpointSubscription', body);

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

function waitForState(node, peer, origin, predicate, what) {
	let last;
	return waitForCondition(async () => predicate((last = await stateFor(node, peer, origin))), {
		timeoutMs: CONVERGE_TIMEOUT_MS,
		description: () =>
			`${node.hostname}'s state for ${origin.hostname} via ${peer.hostname}: ${what}; last observed ${JSON.stringify(last)}`,
	});
}

const waitForEvents = (node, name, ids) =>
	waitForCondition(
		async () => {
			const { events } = await subscription(node, { action: 'status', name });
			return ids.every((id) => events.includes(id));
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: `${ids.join(', ')} delivered to ${name} on ${node.hostname}` }
	);

async function waitForCheckpoint(node, name, aboveTime = 0) {
	let status;
	await waitForCondition(
		async () => {
			status = await subscription(node, { action: 'status', name });
			return status.checkpoint !== null && status.checkpoint.time > aboveTime;
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: `a checkpoint past ${aboveTime} from ${name} on ${node.hostname}` }
	);
	return status.checkpoint;
}

const logPath = (node) => join(node.logDir ?? join(node.dataRootDir, 'log'), 'hdb.log');
const readText = (path) =>
	readFile(path, 'utf8').catch((error) => (error.code === 'ENOENT' ? '' : Promise.reject(error)));

/** `observedSince` is the first poll that saw the current value, not proof it held in between. */
function clauseTracker(clauses) {
	const report = Object.fromEntries(
		Object.keys(clauses).map((name) => [name, { holds: null, observedSince: null, polls: 0, heldPolls: 0 }])
	);
	let lastState;
	let lastAt = null;
	return {
		observe(state) {
			lastState = state;
			lastAt = new Date().toISOString();
			let all = true;
			for (const [name, clause] of Object.entries(clauses)) {
				const holds = clause(state);
				const entry = report[name];
				if (entry.holds !== holds) Object.assign(entry, { holds, observedSince: lastAt });
				entry.polls++;
				if (holds) entry.heldPolls++;
				all &&= holds;
			}
			return all;
		},
		report: () => ({ lastAt, lastState: lastState ?? null, clauses: report }),
	};
}

const logTime = (line) => line.slice(0, 24);
async function logLinesSince(path, from, needle, following = 0) {
	const text = await readText(path).catch(() => '');
	if (!text || from > text.length) return null;
	const lines = text.slice(from).split('\n');
	const found = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes(needle)) found.push(lines.slice(i, i + 1 + following).join(' '));
	}
	return found;
}

async function dependencyVersions() {
	const root = join(TEST_DIR, '..', '..');
	const versionOf = (path) =>
		readFile(path, 'utf8')
			.then((text) => JSON.parse(text).version)
			.catch(() => null);
	const versions = { node: process.version, gitSha: process.env.GITHUB_SHA ?? null };
	versions['harper-pro'] = await versionOf(join(root, 'package.json'));
	for (const name of ['@harperfast/rocksdb-js', 'msgpackr', 'lmdb', 'structon', '@harperfast/integration-testing']) {
		versions[name] = await versionOf(join(root, 'node_modules', name, 'package.json'));
	}
	return versions;
}

// A sender's `certified origin floors` line is logged at send, not at the receiver's commit, and names no database:
// it correlates with B's row, it does not prove it. `bulk copy complete` names no database either.
async function reportWidening(t, widening) {
	const { A, B, marks } = widening;
	const certificates = await logLinesSince(marks.aLog, marks.aLogFrom, `certified origin floors to ${B.hostname} `, 2);
	const entryPattern = new RegExp(
		`'${A.hostname.replaceAll('.', '\\.')}' => \\[ ([\\d.]+), '[0-9a-f]+', (true|false) \\]`
	);
	const windowKnown = marks.rewrittenAt !== undefined && marks.stopReturnedAt !== undefined;
	const sendsWhileStopping = (windowKnown ? certificates : null)?.filter(
		(line) => logTime(line) >= marks.rewrittenAt && logTime(line) <= marks.stopReturnedAt
	);
	const certificatesWhileStopping = sendsWhileStopping
		?.map((line) => {
			const entry = line.match(entryPattern);
			return entry && { at: logTime(line), floor: Number(entry[1]), fullCoverage: entry[2] === 'true' };
		})
		.filter(Boolean);
	const shutdown = await logLinesSince(marks.bLogBeforeStop, marks.bLogFrom, '[notify]: ');
	const restartLog = (needle) => logLinesSince(marks.bLogAfterStart, marks.bLogAfterStartFrom ?? 0, needle);
	const resume = (await restartLog(`Starting time recorded in db ${A.hostname} `))?.filter((line) =>
		/ data [\d.]+ start time: /.test(line)
	);
	const resumeMatch = resume?.[0]?.match(/start time: ([\d.]+)/);
	const resumeStart = resumeMatch ? Number(resumeMatch[1]) : null;
	const firstMatch = async (needle, ...scopes) =>
		(await restartLog(needle))?.find((line) => scopes.every((scope) => line.includes(scope))) ?? null;
	const summary = {
		clauses: widening.clauses?.report() ?? null,
		coverageRewrite: widening.coverage ?? null,
		bStop: {
			signalledAt: shutdown?.find((line) => line.includes('Received SIGTERM'))?.slice(0, 24) ?? null,
			completedAt: shutdown?.find((line) => line.includes('Shutdown complete'))?.slice(0, 24) ?? null,
			returnedAfterMs: marks.stopReturnedAfterMs ?? null,
		},
		certificateSendsToBWhileStopping: sendsWhileStopping?.length ?? 'unknown',
		certificatesWhileStopping: certificatesWhileStopping ?? 'unknown',
		bRestart: resume?.length
			? {
					resumeStart,
					resumedJustBelowACertificateFloor:
						resumeStart === null
							? null
							: (certificatesWhileStopping?.some(({ floor }) => resumeStart < floor && floor - resumeStart < 1e-3) ??
								null),
					widened: await firstMatch(`Route coverage widened to full for ${A.hostname} on database data `),
					fullCopyRequested: await firstMatch('full copy', 'database data', A.hostname),
					bulkCopyCompleteAnyDatabase: await firstMatch(`bulk copy complete from ${A.hostname}`),
				}
			: 'unknown',
		beforeRewriteRows: widening.beforeRewrite ?? null,
		afterRestartRows: (await widening.afterRestart) ?? null,
		atWaitEndRows: (await widening.atWaitEnd) ?? null,
		heldTransaction: {
			openedAt: marks.heldAt ?? null,
			releasedAt: marks.releasedAt ?? null,
			cleanupReleasedAt: marks.cleanupReleasedAt ?? null,
			abortedAt: (await logLinesSince(marks.aLog, marks.aLogFrom, 'open too long'))?.map(logTime) ?? 'unknown',
		},
		timeline: marks,
		versions: await dependencyVersions(),
	};
	const readBackNodes = summary.coverageRewrite?.readBack?.nodes;
	const fullCoverageAtRewrite = Array.isArray(readBackNodes)
		? [...new Set(readBackNodes.map((node) => node.fullCoverage))]
		: null;
	t.diagnostic(
		`widening: ${JSON.stringify({
			clauses: Object.fromEntries(
				Object.entries(summary.clauses?.clauses ?? {}).map(([name, { holds }]) => [name, holds])
			),
			rewriteUpdated: summary.coverageRewrite?.updated ?? null,
			fullCoverageAtRewrite,
			certificateSendsToBWhileStopping: summary.certificateSendsToBWhileStopping,
			certificatesWhileStopping: Array.isArray(certificatesWhileStopping)
				? certificatesWhileStopping.length
				: 'unknown',
			resumedJustBelowACertificateFloor: summary.bRestart.resumedJustBelowACertificateFloor ?? null,
			widened: typeof summary.bRestart === 'object' ? Boolean(summary.bRestart.widened) : 'unknown',
			bulkCopyCompleteAnyDatabase:
				typeof summary.bRestart === 'object' ? Boolean(summary.bRestart.bulkCopyCompleteAnyDatabase) : 'unknown',
			stopMs: summary.bStop.returnedAfterMs,
			heldAbortedAt: summary.heldTransaction.abortedAt,
		})}`
	);
	const directory = process.env.HARPER_INTEGRATION_TEST_LOG_DIR;
	if (directory) {
		const file = join(directory, `subscriptionCheckpointResume-widening-${B.hostname}-${Date.now()}.json`);
		await writeFile(file, JSON.stringify(summary, null, '\t'));
		t.diagnostic(`widening diagnostics: ${file}`);
	}
}

function mqttUrlFor(node) {
	const wsScheme = node.httpURL.startsWith('https') ? 'wss' : 'ws';
	return `${node.httpURL.replace(/^https?/, wsScheme)}/mqtt`;
}

function connectMqtt(node, clientId) {
	return new Promise((resolve, reject) => {
		const received = [];
		const client = mqtt.connect(mqttUrlFor(node), {
			protocolVersion: 5,
			reconnectPeriod: 0,
			connectTimeout: 8000,
			clean: false,
			clientId,
			username: node.admin.username,
			password: node.admin.password,
		});
		client.on('message', (topic, payload) => received.push({ topic, payload: payload.toString() }));
		client.once('error', (error) => {
			client.end(true);
			reject(error);
		});
		client.once('connect', (connack) => resolve({ client, received, sessionPresent: connack.sessionPresent }));
	});
}

const subscribeMqtt = (client, topic) =>
	new Promise((resolve, reject) =>
		client.subscribe(topic, { qos: 1, rh: 2 }, (error, granted) => (error ? reject(error) : resolve(granted)))
	);
const endMqtt = (client) => new Promise((resolve) => client.end(true, {}, () => resolve()));
const topicIds = (received) => received.map(({ topic }) => topic.split('/').pop());

const SUITE = 'Subscription checkpoints resume across nodes (harper-pro#922 items 3–4)';
suite(SUITE, { timeout: 900_000 }, (ctx) => {
	before(async () => {
		[ctx.A, ctx.B, ctx.C, ctx.E] = await Promise.all([
			startNewNode(ctx.name),
			startNewNode(ctx.name),
			startNewNode(ctx.name),
			startNewNode(ctx.name, { HARPER_TEST_OMIT_REPLICATION_CAPABILITIES: '1' }),
		]);
		const { A, B, C, E } = ctx;
		const marks = new Map(
			await Promise.all([A, B, C, E].map(async (node) => [node, (await readText(logPath(node))).length]))
		);
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
					async () =>
						(await readText(logPath(node))).slice(marks.get(node)).includes(`bulk copy complete from ${peer.hostname}`),
					{ timeoutMs: CONVERGE_TIMEOUT_MS, description: `${node.hostname} to finish its copy from ${peer.hostname}` }
				)
			)
		);
		await upsert(A, 'seed');
		await Promise.all([waitForRecord(B, 'seed'), waitForRecord(C, 'seed'), waitForRecord(E, 'seed')]);
	});

	after(async () => {
		await stopAndTeardownNodes([ctx.A, ctx.B, ctx.C, ctx.E].filter(Boolean));
	});

	test('level-2 certificates carry the origin generation and coverage, and a restart resumes floor-only', async () => {
		const { A, B, C, E } = ctx;
		const closedFloorsOnB = await postToFixture(B, 'ClosedFloors', { peer: A.hostname });
		equal(closedFloorsOnB.syncWalInstalled, true, 'standinSyncWal is installed on the database rootStore');
		const checkpointGrade = (state) =>
			state?.closedFloor > 0 && typeof state.originGeneration === 'string' && state.fullCoverage === true;
		await waitForState(B, A, A, checkpointGrade, 'a checkpoint-grade certificate from A');
		await waitForState(C, B, B, checkpointGrade, "B's own certificate");
		await waitForState(B, C, C, checkpointGrade, "C's own certificate on B");
		await waitForState(
			C,
			B,
			A,
			(state) => state?.closedFloor > 0 && state.originGeneration == null,
			"A's floor relayed through B as level 1 before B has a certifiedFrom prefix for A"
		);
		equal(
			(await stateFor(A, E, E))?.originGeneration ?? null,
			null,
			'a peer without the capability certifies at no level'
		);
		equal((await stateFor(E, A, A))?.originGeneration ?? null, null, 'E stores no certificate');

		await restartNode(B);
		await waitForState(B, A, A, (state) => state?.certifiedFrom > 0, "B's route to A marked certified-from");
		await waitForState(B, C, C, (state) => state?.certifiedFrom > 0, "B's route to C marked certified-from");
		await waitForState(C, B, A, checkpointGrade, "A's certificate relayed through B with its coverage");
		await restartNode(C);
		await waitForState(C, B, A, (state) => state?.certifiedFrom > 0, "C's route to A marked certified-from");
		await waitForState(C, B, B, (state) => state?.certifiedFrom > 0, "C's route to B marked certified-from");
		const onB = await stateFor(B, A, A);
		ok(onB.certifiedFrom <= onB.closedFloor, 'the mark is at or below the floor it resumed from');
		equal(onB.floorRevoked, null, 'nothing was revoked');
		equal(onB.hole, null, 'no hole was recorded');
		await upsert(A, 'after-restarts');
		await Promise.all([B, C, E].map((node) => waitForRecord(node, 'after-restarts')));
	});

	test('a checkpoint issued on C names no healthy origin and resumes on B, delivering a transaction A held open', async () => {
		const { A, B, C } = ctx;
		await subscription(C, { action: 'open', name: 'issuer' });
		await upsert(A, 'x1');
		await waitForEvents(C, 'issuer', ['x1']);
		const first = await waitForCheckpoint(C, 'issuer');
		equal(first.v, 1);
		deepEqual(first.exceptions, {}, 'A, B and C are all healthy: no origin is named');
		ok(first.members.length === 64, 'the member set is a digest, not a list');

		await postToFixture(A, 'HoldTransaction', { id: 'held' });
		await upsert(A, 'early');
		await waitForEvents(C, 'issuer', ['early']);
		// the floor cannot pass the held transaction's reservation, so the checkpoint waits below it
		await new Promise((resolve) => setTimeout(resolve, 2 * FLOOR_INTERVAL_MS));
		const checkpoint = await waitForCheckpoint(C, 'issuer', first.time);
		await subscription(C, { action: 'close', name: 'issuer' });
		await postToFixture(A, 'ReleaseTransaction', {});
		await waitForRecord(B, 'held');
		await upsert(A, 'after');
		await waitForRecord(B, 'after');

		const resumed = await subscription(B, { action: 'resume', name: 'resumer', checkpoint });
		equal(resumed.refused, undefined, `B refused the checkpoint: ${JSON.stringify(resumed.refused)}`);
		await waitForEvents(B, 'resumer', ['held', 'after']);
		const status = await subscription(B, { action: 'status', name: 'resumer' });
		equal(status.verified, true, 'the replay verified');
		deepEqual(status.errors, []);
		// x1 may be replayed: a healthy origin's boundary trails its writes by up to the certificate cadence
		await subscription(B, { action: 'close', name: 'resumer' });

		const foreign = { ...checkpoint, members: 'f'.repeat(64) };
		const refused = await subscription(B, { action: 'resume', name: 'foreign', checkpoint: foreign });
		equal(refused.refused?.statusCode, 410, 'a member set this node cannot serve is refused');
		equal(refused.refused?.code, 'RESUME_HISTORY_UNAVAILABLE');

		const scalarResumed = await subscription(B, { action: 'resume', name: 'scalar', startTime: checkpoint.time });
		equal(scalarResumed.refused, undefined, 'a scalar start-time resume is accepted without checkpoint verification');
		await waitForEvents(B, 'scalar', ['after']);
		const scalarStatus = await subscription(B, { action: 'status', name: 'scalar' });
		equal(scalarStatus.verified, null, 'scalar-only resume does not run checkpoint verification');
		ok(
			!scalarStatus.events.includes('held'),
			'scalar startTime at checkpoint.time misses the transaction held below it'
		);
		await subscription(B, { action: 'close', name: 'scalar' });
	});

	test('an MQTT durable session fails over from C to B and receives the transaction committed below its checkpoint', async () => {
		const { A, B, C } = ctx;
		const clientId = `checkpoint-${randomUUID().slice(0, 8)}`;
		const topic = `${TABLE}/#`;
		const onC = await connectMqtt(C, clientId);
		await subscribeMqtt(onC.client, topic);
		await upsert(A, 'm1');
		await waitForCondition(() => topicIds(onC.received).includes('m1'), {
			timeoutMs: CONVERGE_TIMEOUT_MS,
			description: 'm1 delivered on C',
		});
		// the session adopts its first checkpoint only at a save after the floors pass everything it acknowledged, and
		// an acknowledgement's own save never qualifies, so a replacing SUBSCRIBE is retried until one does
		await waitForCondition(
			async () => {
				await subscribeMqtt(onC.client, topic);
				const { record } = await postToFixture(C, 'DurableSessionRecord', { id: clientId });
				return record?.subscriptions?.[0]?.checkpoint !== undefined;
			},
			{ timeoutMs: CONVERGE_TIMEOUT_MS, description: 'the durable session to adopt its first checkpoint on C' }
		);
		await postToFixture(A, 'HoldTransaction', { id: 'held2' });
		await upsert(A, 'early2');
		await waitForCondition(() => topicIds(onC.received).includes('early2'), {
			timeoutMs: CONVERGE_TIMEOUT_MS,
			description: 'early2 delivered on C',
		});
		await endMqtt(onC.client);
		await postToFixture(A, 'ReleaseTransaction', {});
		await waitForRecord(B, 'held2');
		await upsert(A, 'after2');
		await waitForRecord(B, 'after2');
		// the row reaches B as it would through system-database replication, which this topology does not run
		const { record: final } = await postToFixture(C, 'DurableSessionRecord', { id: clientId });
		ok(final.subscriptions[0].checkpoint, 'the final save keeps the checkpoint');
		ok(final.subscriptions[0].startTime !== undefined, 'the scalar shadow is kept beside the checkpoint');
		await postToFixture(B, 'DurableSessionRecord', { record: final });
		const onB = await connectMqtt(B, clientId);
		try {
			equal(onB.sessionPresent, true, 'B resumed the session');
			await waitForCondition(() => ['held2', 'after2'].every((id) => topicIds(onB.received).includes(id)), {
				timeoutMs: CONVERGE_TIMEOUT_MS,
				description: 'held2 and after2 delivered on B after the failover',
			});
			// m1 may be sent again as a duplicate for the same reason; nothing acknowledged before it is
		} finally {
			await endMqtt(onB.client);
		}
	});
	test('a route widened from partial coverage runs a full base copy and clears partialHistory without certifying audit-less copyApply history', async (t) => {
		const { A, B } = ctx;
		const marks = { aLog: logPath(A), aLogFrom: (await readText(logPath(A))).length };
		const widening = { A, B, marks };
		const now = () => new Date().toISOString();
		marks.heldAt = now();
		await postToFixture(A, 'HoldTransaction', { id: 'held-copy-bound' });
		try {
			await upsert(A, 'copied-above-pinned-floor');
			await upsert(A, 'copy-anchor-record');
			await waitForRecord(B, 'copy-anchor-record');
			const copiedVersions = await postToFixture(A, 'RecordVersions', {
				ids: ['copied-above-pinned-floor', 'copy-anchor-record'],
			});
			const maxCopiedVersion = Math.max(
				copiedVersions['copied-above-pinned-floor'] ?? 0,
				copiedVersions['copy-anchor-record'] ?? 0
			);
			marks.maxCopiedVersion = maxCopiedVersion;
			marks.bLogBeforeStop = logPath(B);
			marks.bLogFrom = (await readText(marks.bLogBeforeStop)).length;
			widening.beforeRewrite = await floorsOn(B, A, { copyRows: true }).catch((error) => ({ error: error.message }));
			widening.coverage = await postToFixture(B, 'SetRouteCoverage', { peer: A.hostname, fullCoverage: false });
			marks.rewrittenAt = widening.coverage.writtenAt;
			const stopStarted = Date.now();
			await stopNodeProcess(B);
			marks.stopReturnedAt = now();
			marks.stopReturnedAfterMs = Date.now() - stopStarted;
			const stoppedLogLength = (await readText(marks.bLogBeforeStop)).length;
			await startNode(B);
			marks.bLogAfterStart = logPath(B);
			// a runner without a log dir appends every start to one file
			marks.bLogAfterStartFrom = marks.bLogAfterStart === marks.bLogBeforeStop ? stoppedLogLength : 0;
			widening.afterRestart = floorsOn(B, A, { copyRows: true }).catch((error) => ({ error: error.message }));
			await upsert(A, 'after-widening-copy');
			await waitForRecord(B, 'after-widening-copy');
			marks.deliveredAt = now();
			widening.clauses = clauseTracker({
				'partialHistory === false': (state) => state?.partialHistory === false,
				'fullCoverage === true': (state) => state?.fullCoverage === true,
				'closedFloor > 0': (state) => state?.closedFloor > 0,
				'certifiedFrom === null': (state) => state?.certifiedFrom === null,
			});
			try {
				await waitForState(
					B,
					A,
					A,
					(state) => widening.clauses.observe(state),
					'widening to full coverage triggers a full base copy that clears partialHistory without certifying audit-less copyApply history'
				);
				marks.waitEndedAt = now();
			} catch (error) {
				marks.waitEndedAt = now();
				widening.atWaitEnd = floorsOn(B, A, { copyRows: true }).catch((cause) => ({ error: cause.message }));
				throw error;
			}

			const logKeyBeforePinnedRestart = (await stateFor(B, A, A))?.originLogKey ?? 0;
			await restartNode(B);
			await upsert(A, 'while-floor-pinned');
			await waitForRecord(B, 'while-floor-pinned');
			await waitForState(
				B,
				A,
				A,
				(state) => (state?.originLogKey ?? 0) > logKeyBeforePinnedRestart,
				"B's seq row for A to persist the post-restart resume batch while A's floor is still pinned"
			);
			equal(
				(await stateFor(B, A, A))?.certifiedFrom,
				null,
				'persisted copyBound suppresses floor-only certification while closedFloor <= maxCopiedVersion'
			);

			await postToFixture(A, 'ReleaseTransaction', {});
			marks.releasedAt = now();
			await upsert(A, 'after-floor-unpinned');
			await waitForRecord(B, 'after-floor-unpinned');
			await waitForState(
				B,
				A,
				A,
				(state) => (state?.closedFloor ?? 0) > maxCopiedVersion + 1,
				"A's closedFloor on B to advance past the copied rows after releasing the held transaction"
			);
		} finally {
			const cleanup = await postToFixture(A, 'ReleaseTransaction', {}).catch(() => {});
			if (cleanup?.released) marks.cleanupReleasedAt = now();
			await reportWidening(t, widening).catch((error) => t.diagnostic(`widening diagnostics failed: ${error.stack}`));
		}

		await restartNode(B);
		let firstCertifiedFrom = 0;
		await waitForState(
			B,
			A,
			A,
			(state) => {
				if (
					state?.partialHistory === false &&
					state?.fullCoverage === true &&
					state?.closedFloor > 0 &&
					state?.certifiedFrom > 0
				) {
					firstCertifiedFrom = state.certifiedFrom;
					return true;
				}
				return false;
			},
			'subsequent floor-only reconnect records certifiedFrom on the restored route'
		);
		await upsert(A, 'after-first-certified-resume');
		await waitForRecord(B, 'after-first-certified-resume');
		const floorBeforeSecondRestart = (await stateFor(B, A, A))?.closedFloor ?? 0;
		await waitForState(
			B,
			A,
			A,
			(state) => (state?.closedFloor ?? 0) > floorBeforeSecondRestart,
			"A's floor on B to advance past firstCertifiedFrom"
		);
		await postToFixture(A, 'HoldTransaction', { id: 'held-second-certified-resume' });
		try {
			await upsert(A, 'above-held-second-resume');
			await waitForRecord(B, 'above-held-second-resume');
			await stopNodeProcess(B);
		} finally {
			await postToFixture(A, 'ReleaseTransaction', {}).catch(() => {});
		}
		await startNode(B);
		await waitForRecord(B, 'held-second-certified-resume');
		await upsert(A, 'after-second-certified-resume');
		await waitForRecord(B, 'after-second-certified-resume');
		const floorAfterSecondRestart = (await stateFor(B, A, A))?.closedFloor ?? 0;
		await waitForState(
			B,
			A,
			A,
			(state) => (state?.closedFloor ?? 0) > floorAfterSecondRestart && state?.certifiedFrom === firstCertifiedFrom,
			'lowest-wins certifiedFrom preserved across a second floor-only reconnect with a higher floor'
		);
	});
	test('a peer that stops certifying at level 2 is revoked on its direct receiver and one hop beyond', async () => {
		const { A, B, C } = ctx;
		A.testEnv = { HARPER_TEST_FORCE_ORIGIN_FLOORS_LEVEL_1: '1' };
		await restartNode(A);
		await waitForState(B, A, A, (state) => state?.floorRevoked === true, "A revoked on B after A's downgrade");
		await waitForState(C, B, A, (state) => state?.floorRevoked === true, 'the revocation relayed to C');
		equal((await stateFor(B, A, A)).closedFloor, null, 'a revoked origin keeps no floor');
		await subscription(C, { action: 'open', name: 'after-downgrade' });
		await upsert(A, 'post-downgrade');
		await waitForEvents(C, 'after-downgrade', ['post-downgrade']);
		const bFloorBefore = (await stateFor(C, B, B))?.closedFloor ?? 0;
		await waitForState(
			C,
			B,
			B,
			(state) => (state?.closedFloor ?? 0) > bFloorBefore,
			"B's own floor certificate to advance on C after post-downgrade"
		);
		const status = await subscription(C, { action: 'status', name: 'after-downgrade' });
		equal(status.checkpoint, null, 'strict availability: no checkpoint while a known origin is revoked');
		await subscription(C, { action: 'close', name: 'after-downgrade' });
		A.testEnv = undefined;
		await restartNode(A);
		await upsert(A, 'post-upgrade');
		await waitForRecord(C, 'post-upgrade');
		const bFloorBeforeUpgrade = (await stateFor(C, B, B))?.closedFloor ?? 0;
		await waitForState(
			C,
			B,
			B,
			(state) => (state?.closedFloor ?? 0) > bFloorBeforeUpgrade,
			"B's floor certificate to advance on C after A's upgrade"
		);
		equal((await stateFor(B, A, A)).floorRevoked, true, 'a revocation is sticky within the generation');

		C.testEnv = { HARPER_TEST_OMIT_REPLICATION_CAPABILITIES: '1' };
		await restartNode(C);
		await waitForState(
			B,
			C,
			C,
			(state) => state?.floorRevoked === true && state?.closedFloor === null,
			'C revoked on B after C restarts without a capability bag'
		);
	});
});
