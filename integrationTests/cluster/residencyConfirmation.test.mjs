/**
 * `replicatedConfirmation: N` counts only peers resident for the written records (harper-pro#1031).
 *
 * Three nodes W, B, C. `Placed` records name their homes; `Open` has no residency function, so a
 * `replicateTo` list places it. With B (the only other resident) down, C receives only an invalidation
 * for a record homed on [W, B] — or nothing — yet its applied watermark passes the write. A write
 * confirmed by C would report "held by 1 other node" while none holds it.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
	startHarper,
	killHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const FIXTURE = join(import.meta.dirname, 'fixture-residency-confirmation');
const NOT_CONFIRMED_WINDOW_MS = 3_000;

function optionsFor(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true, level: 'warn' },
			replication: { securePort: hostname + ':9933' },
		},
	};
}

async function startNode(suiteName) {
	const hostname = await getNextAvailableLoopbackAddress();
	const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
	await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true, dereference: true });
	const ctx = { name: suiteName, harper: { hostname, dataRootDir } };
	await startHarper(ctx, optionsFor(hostname));
	return ctx;
}

function waitForMesh(nodes) {
	return waitForCondition(
		async (signal) => {
			const statuses = await Promise.all(
				nodes.map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal }).catch(() => undefined))
			);
			return statuses.every(
				(status) =>
					status?.connections.length === nodes.length - 1 &&
					status.connections.every((connection) =>
						connection.database_sockets.some((socket) => socket.database === 'data' && socket.connected)
					)
			);
		},
		{ timeoutMs: 90_000, description: 'every node connected to every other node on data' }
	);
}

/**
 * PUT through REST, which runs on an HTTP worker: the operations API runs on the main thread, which loads
 * no application code, so `setResidency` would not apply there. `X-Replicate-To: <nodes|*>;confirm=N`.
 * Settles to { status, body } — never rejects, so a pending write can be raced.
 */
async function put(node, path, body, replicateTo) {
	try {
		const response = await fetch(`${node.httpURL}/${path}`, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
				'X-Replicate-To': replicateTo,
			},
			body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.text() };
	} catch (error) {
		return { status: 'request failed', body: String(error) };
	}
}

async function readBody(node, table, id, signal) {
	const [record] = await sendOperation(
		node,
		{
			operation: 'search_by_id',
			database: 'data',
			table,
			ids: [id],
			get_attributes: ['id', 'body'],
		},
		{ signal }
	);
	return record?.body;
}

suite('replicatedConfirmation counts only resident peers', { timeout: 600_000 }, (ctx) => {
	const contexts = [];
	let W, B, C;
	let names;

	before(async () => {
		const started = await Promise.allSettled([startNode(ctx.name), startNode(ctx.name), startNode(ctx.name)]);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		[W, B, C] = contexts.map((c) => c.harper);
		const { operation_token: token } = await sendOperation(W, {
			operation: 'create_authentication_tokens',
			authorization: W.admin,
		});
		for (const node of [B, C]) {
			await sendOperation(node, {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: W.hostname,
				authorization: 'Bearer ' + token,
			});
		}
		await waitForMesh([W, B, C]);
		names = {};
		for (const [label, node] of Object.entries({ W, B, C }))
			names[label] = (await sendOperation(node, { operation: 'cluster_status' })).node_name;
		const warmup = await put(
			W,
			'Placed/warmup',
			{ id: 'warmup', homes: [names.W, names.B, names.C], body: 'w' },
			'*;confirm=2'
		);
		assert.ok(warmup.status < 300, JSON.stringify(warmup));
	});

	after(async () => {
		for (const c of contexts) {
			await stopNodeProcess(c.harper).catch(() => {});
			await teardownHarper(c).catch((error) => console.error(`teardown of ${c.harper.hostname} failed:`, error));
		}
	});

	test('a count larger than the other residents fails at once and writes nothing', async () => {
		const response = await put(
			W,
			'Placed/too-few',
			{ id: 'too-few', homes: [names.W, names.B], body: 'x' },
			'*;confirm=2'
		);
		assert.equal(response.status, 400, JSON.stringify(response));
		assert.match(response.body, /resident on 1 other node\(s\)/);
		assert.equal(await readBody(W, 'Placed', 'too-few'), undefined);
	});

	test('a non-resident or replicateTo-excluded peer that applied the write does not confirm it', async () => {
		await killHarper({ harper: B });
		const homedOnB = put(
			W,
			'Placed/homed-on-b',
			{ id: 'homed-on-b', homes: [names.W, names.B], body: 'b' },
			'*;confirm=1'
		);
		const replicatedToB = put(W, 'Open/to-b', { id: 'to-b', body: 'b' }, `${names.B};confirm=1`);
		// one transaction (array PUT); C holds the second record, but only B holds the first
		const mixed = put(
			W,
			'Placed/',
			[
				{ id: 'mixed-b', homes: [names.W, names.B], body: 'b' },
				{ id: 'mixed-c', homes: [names.W, names.C], body: 'c' },
			],
			'*;confirm=1'
		);
		const writes = { homedOnB, replicatedToB, mixed };
		const settled = {};
		for (const [label, pending] of Object.entries(writes)) pending.then((response) => (settled[label] = response));
		// committed on W before the probe below, so C confirming the probe means C has applied them
		await waitForCondition(
			async (signal) =>
				(await readBody(W, 'Placed', 'homed-on-b', signal)) === 'b' &&
				(await readBody(W, 'Open', 'to-b', signal)) === 'b' &&
				(await readBody(W, 'Placed', 'mixed-b', signal)) === 'b',
			{ timeoutMs: 30_000, description: 'the tested writes to commit on W' }
		);
		const laterOnC = await put(
			W,
			'Placed/later-on-c',
			{ id: 'later-on-c', homes: [names.W, names.C], body: 'c' },
			'*;confirm=1'
		);
		assert.ok(laterOnC.status < 300, JSON.stringify(laterOnC));
		assert.equal(await readBody(C, 'Placed', 'later-on-c'), 'c');
		await new Promise((resolve) => setTimeout(resolve, NOT_CONFIRMED_WINDOW_MS));
		assert.deepEqual(settled, {}, 'confirmed with the only other resident down');

		B = (await startHarper({ name: ctx.name, harper: B }, optionsFor(B.hostname))).harper;
		contexts[1].harper = B;
		for (const label of Object.keys(writes)) {
			const response = await waitForCondition(() => settled[label], {
				timeoutMs: 120_000,
				description: `${label} to be confirmed once B is back`,
			});
			assert.ok(response.status < 300, `${label}: ${JSON.stringify(response)}`);
		}
		assert.equal(await readBody(B, 'Placed', 'homed-on-b'), 'b');
		assert.equal(await readBody(B, 'Placed', 'mixed-b'), 'b');
		assert.equal(await readBody(B, 'Open', 'to-b'), 'b');
	});
});
