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
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import mqtt from 'mqtt';
import { killHarper, startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
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
	env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_ORIGIN_FLOOR_INTERVAL_MS: String(FLOOR_INTERVAL_MS), ...env },
});

async function startNode(node) {
	const started = (await startHarper({ name: node.name, harper: node }, nodeOptions(node, node.testEnv))).harper;
	return Object.assign(node, started);
}

async function restartNode(node) {
	await killHarper({ harper: node });
	return startNode(node);
}

async function startNewNode(suiteName, testEnv) {
	const nodeCtx = { name: suiteName, harper: { hostname: await getNextAvailableLoopbackAddress(), testEnv } };
	await startHarper(nodeCtx, nodeOptions(nodeCtx.harper, testEnv));
	// the fixture's schema defines and exports the table, so it is an MQTT topic from the first boot
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

const floorsOn = (node, peer) => postToFixture(node, 'ClosedFloors', { peer: peer.hostname });
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

const waitForState = (node, peer, origin, predicate, what) =>
	waitForCondition(async () => predicate(await stateFor(node, peer, origin)), {
		timeoutMs: CONVERGE_TIMEOUT_MS,
		description: `${node.hostname}'s state for ${origin.hostname} via ${peer.hostname}: ${what}`,
	});

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

suite('Subscription checkpoints resume across nodes (harper-pro#922 items 3–4)', { timeout: 900_000 }, (ctx) => {
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
		const checkpointGrade = (state) =>
			state?.closedFloor > 0 && typeof state.originGeneration === 'string' && state.fullCoverage === true;
		await waitForState(B, A, A, checkpointGrade, 'a checkpoint-grade certificate from A');
		await waitForState(C, B, A, checkpointGrade, "A's certificate relayed through B with its coverage");
		await waitForState(C, B, B, checkpointGrade, "B's own certificate");
		equal(
			(await stateFor(A, E, E))?.originGeneration ?? null,
			null,
			'a peer without the capability certifies at no level'
		);
		equal((await stateFor(E, A, A))?.originGeneration ?? null, null, 'E stores no certificate');

		// a reconnect on a level-2 route resumes exactly below the floor and records where its complete prefix begins
		await restartNode(B);
		await restartNode(C);
		await waitForState(B, A, A, (state) => state?.certifiedFrom > 0, "B's route to A marked certified-from");
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
		await postToFixture(A, 'HoldTransaction', { id: 'held2' });
		await upsert(A, 'early2');
		await waitForCondition(() => topicIds(onC.received).includes('early2'), {
			timeoutMs: CONVERGE_TIMEOUT_MS,
			description: 'early2 delivered on C',
		});
		// the session persists its checkpoint beside the scalar position once the floors certify it
		let record;
		await waitForCondition(
			async () => {
				({ record } = await postToFixture(C, 'DurableSessionRecord', { id: clientId }));
				return record?.subscriptions?.[0]?.checkpoint !== undefined;
			},
			{ timeoutMs: CONVERGE_TIMEOUT_MS, description: 'the durable session to carry a checkpoint on C' }
		);
		const saved = record.subscriptions[0];
		ok(saved.startTime !== undefined, 'the scalar shadow is kept beside the checkpoint');
		await endMqtt(onC.client);
		await postToFixture(A, 'ReleaseTransaction', {});
		await waitForRecord(B, 'held2');
		await upsert(A, 'after2');
		await waitForRecord(B, 'after2');
		// the row reaches B as it would through system-database replication, which this topology does not run
		const { record: final } = await postToFixture(C, 'DurableSessionRecord', { id: clientId });
		ok(final.subscriptions[0].checkpoint, 'the final save keeps the checkpoint');
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
	test('a peer that stops certifying at level 2 is revoked on its direct receiver and one hop beyond', async () => {
		const { A, B, C } = ctx;
		// A comes back without a capability bag: an older binary that may write below the floor it certified
		A.testEnv = { HARPER_TEST_OMIT_REPLICATION_CAPABILITIES: '1' };
		await restartNode(A);
		await waitForState(B, A, A, (state) => state?.floorRevoked === true, "A revoked on B after A's downgrade");
		await waitForState(C, B, A, (state) => state?.floorRevoked === true, 'the revocation relayed to C');
		equal((await stateFor(B, A, A)).closedFloor, null, 'a revoked origin keeps no floor');
		await subscription(C, { action: 'open', name: 'after-downgrade' });
		await upsert(A, 'post-downgrade');
		await waitForEvents(C, 'after-downgrade', ['post-downgrade']);
		await new Promise((resolve) => setTimeout(resolve, 3 * FLOOR_INTERVAL_MS));
		const status = await subscription(C, { action: 'status', name: 'after-downgrade' });
		equal(status.checkpoint, null, 'strict availability: no checkpoint while a known origin is revoked');
		await subscription(C, { action: 'close', name: 'after-downgrade' });
		// back on level 2, A's next certificate names the same generation and stays revoked
		A.testEnv = undefined;
		await restartNode(A);
		await upsert(A, 'post-upgrade');
		await waitForRecord(C, 'post-upgrade');
		await new Promise((resolve) => setTimeout(resolve, 3 * FLOOR_INTERVAL_MS));
		equal((await stateFor(B, A, A)).floorRevoked, true, 'a revocation is sticky within the generation');
	});
});
