import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';
import { LATENCY_POSITION, REPLICATION_SHARED_STATUS_SLOTS } from '../../dist/replication/sharedStatusSlots.js';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const ALL_REPLICAS = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? '*' : '*;confirm=3';
const FIXTURE = join(import.meta.dirname, 'fixture-residency-confirmation');

async function request(node, path, options = {}) {
	const response = await fetch(`${node.httpURL}/${path}`, {
		...options,
		headers: {
			'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
			'Content-Type': 'application/json',
			...options.headers,
		},
		signal: options.signal ?? AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: response.status, body };
}

async function put(node, id, body, replicateTo = '1') {
	const result = await request(node, `Open/${id}`, {
		method: 'PUT',
		headers: { 'X-Replicate-To': replicateTo },
		body: JSON.stringify({ id, ...body }),
	});
	assert.ok(result.status < 300, JSON.stringify(result));
}

async function state(node, id, signal) {
	const result = await request(node, `ResidencyState/Open:${id}`, { signal });
	assert.equal(result.status, 200, JSON.stringify(result));
	return result.body;
}

suite('partial replication reads and placement', { timeout: 600_000 }, (ctx) => {
	const contexts = [];
	let nodes, names;

	before(async () => {
		const started = await Promise.allSettled(
			Array.from({ length: 4 }, async () => {
				const hostname = await getNextAvailableLoopbackAddress();
				const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
				const context = { name: ctx.name, harper: { hostname, dataRootDir } };
				contexts.push(context);
				await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), {
					recursive: true,
					dereference: true,
				});
				await startHarper(context, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: true, console: true, level: 'warn' },
						replication: { securePort: hostname + ':9933' },
					},
				});
				return context.harper;
			})
		);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		nodes = started.map((result) => result.value);
		const { operation_token: token } = await sendOperation(nodes[0], {
			operation: 'create_authentication_tokens',
			authorization: nodes[0].admin,
		});
		for (const node of nodes.slice(1))
			await sendOperation(node, {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: nodes[0].hostname,
				authorization: 'Bearer ' + token,
			});
		await waitForCondition(
			async (signal) => {
				const statuses = await Promise.all(
					nodes.map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal }))
				);
				return statuses.every(
					(status) =>
						status.connections.length === 3 &&
						status.connections.every((connection) =>
							connection.database_sockets.some((socket) => socket.database === 'data' && socket.connected)
						)
				);
			},
			{ timeoutMs: 90_000, description: 'four-node data mesh' }
		);
		names = await Promise.all(
			nodes.map(async (node) => (await sendOperation(node, { operation: 'cluster_status' })).node_name)
		);
		await put(nodes[0], 'warmup', { body: 'ready' }, ALL_REPLICAS);
	});

	after(async () => {
		for (const context of contexts) {
			await stopNodeProcess(context.harper).catch(() => {});
			await teardownHarper(context).catch((error) => console.error(error));
		}
	});

	async function placed(id) {
		return waitForCondition(
			async (signal) => {
				const states = await Promise.all(nodes.map((node) => state(node, id, signal)));
				return states.every((entry) => entry.present) && states;
			},
			{ timeoutMs: 30_000, description: `${id} on every node, including stubs` }
		);
	}

	async function control(node, data) {
		const response = await request(node, 'ResidencyState', {
			method: 'POST',
			body: JSON.stringify({ ...data, latencySlot: LATENCY_POSITION, statusSlots: REPLICATION_SHARED_STATUS_SLOTS }),
		});
		assert.equal(response.status, 200, JSON.stringify(response));
	}

	async function disconnected(reader, indexes) {
		return waitForCondition(
			async (signal) => {
				const status = await sendOperation(nodes[reader], { operation: 'cluster_status' }, { signal });
				const residents = status.connections.filter((connection) =>
					indexes.some((index) => connection.name === names[index])
				);
				return (
					residents.length === indexes.length &&
					residents.every((connection) => connection.database_sockets.every((socket) => !socket.connected))
				);
			},
			{ timeoutMs: 30_000, description: 'resident disconnections' }
		);
	}

	test('count placement stores writer plus one full replica, and a non-resident read returns the payload', async () => {
		await put(nodes[0], 'count', { name: 'count', body: 'complete' });
		const states = await placed('count');
		const full = states.flatMap((entry, index) => (entry.invalidated ? [] : [index]));
		assert.equal(full.length, 2);
		assert.ok(full.includes(0));
		for (const [index, entry] of states.entries()) {
			assert.deepEqual([...entry.residency].sort(), full.map((i) => names[i]).sort());
			assert.equal(entry.value.body, full.includes(index) ? 'complete' : undefined);
		}
		const reader = states.findIndex((entry) => entry.invalidated);
		const response = await request(nodes[reader], 'Open/count');
		assert.equal(response.status, 200, JSON.stringify(response));
		assert.equal(response.body.body, 'complete');
	});

	test('a non-resident collection read loads non-indexed fields', async () => {
		await put(nodes[0], 'query', { name: 'query', body: 'complete query' });
		const states = await placed('query');
		const reader = states.findIndex((entry) => entry.invalidated);
		const result = await request(nodes[reader], 'Open/?name==query&select(id,body)');
		assert.equal(result.status, 200, JSON.stringify(result));
		assert.deepEqual(result.body, [{ id: 'query', body: 'complete query' }]);
	});

	test('a peer excluded from both placements receives the new index and residency', async () => {
		await put(nodes[0], 'moved', { name: 'before', body: 'old payload' });
		const states = await placed('moved');
		const [writer, excluded] = states.flatMap((entry, index) => (entry.invalidated ? [index] : []));
		await put(nodes[writer], 'moved', { name: 'after', body: 'new payload' });
		await put(nodes[writer], 'moved-barrier', { body: 'barrier' }, ALL_REPLICAS);
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb')
			await waitForCondition(
				async (signal) => (await state(nodes[excluded], 'moved', signal)).value?.name === 'after',
				{ timeoutMs: 30_000, description: 'updated excluded-peer stub' }
			);
		const current = await state(nodes[excluded], 'moved');
		assert.equal(current.value.name, 'after', 'excluded peer retained the old indexed value');
		assert.ok(current.invalidated);
		assert.deepEqual(current.residency, [names[writer], names[0]]);
		for (const [name, expected] of [
			['before', []],
			['after', [{ id: 'moved', name: 'after' }]],
		]) {
			const result = await request(nodes[excluded], `Open/?name==${name}&select(id,name)`);
			assert.equal(result.status, 200, JSON.stringify(result));
			assert.deepEqual(result.body, expected);
		}
		const response = await request(nodes[excluded], 'Open/moved');
		assert.equal(response.status, 200, JSON.stringify(response));
		assert.equal(response.body.body, 'new payload');
	});

	test('tries another listed resident after absence, and returns absence when all answer absent', async () => {
		for (const id of ['retry', 'absent']) {
			await put(nodes[0], id, { name: id, body: 'from the remaining resident' });
			const states = await placed(id);
			const full = states.flatMap((entry, index) => (entry.invalidated ? [] : [index]));
			const reader = states.findIndex((entry) => entry.invalidated);
			await control(nodes[full[0]], { removeLocal: id });
			await control(nodes[reader], { prefer: names[full[0]] });
			if (id === 'absent') await control(nodes[full[1]], { removeLocal: id });
			const response = await waitForCondition(
				async (signal) => {
					const result = await request(nodes[reader], `Open/${id}`, { signal });
					return result.status !== 502 && result;
				},
				{ timeoutMs: 30_000, description: `${id} after retrieval connections are available` }
			);
			assert.equal(response.status, id === 'retry' ? 200 : 404, JSON.stringify(response));
			if (id === 'retry') assert.equal(response.body.body, 'from the remaining resident');
		}
	});

	test('a stale list naming only stub holders fails instead of reporting absence', async () => {
		const id = 'stale-list';
		await put(nodes[0], id, { name: id, body: 'still resident elsewhere' });
		const states = await placed(id);
		const [reader, otherStub] = states.flatMap((entry, index) => (entry.invalidated ? [index] : []));
		await control(nodes[reader], { residencyFor: id, residents: [names[otherStub]] });
		try {
			const response = await waitForCondition(
				async (signal) => {
					const result = await request(nodes[reader], `Open/${id}`, { signal });
					return (result.status !== 502 || /not resident/i.test(JSON.stringify(result.body))) && result;
				},
				{ timeoutMs: 30_000, description: 'stale-list holder answers the retrieval request' }
			);
			assert.equal(response.status, 502, JSON.stringify(response));
			assert.match(JSON.stringify(response.body), /not resident/i);
			const query = await request(nodes[reader], `Open/?name==${id}&select(id,body)`);
			assert.ok(
				query.status >= 500 || (query.body.length === 1 && /not resident/i.test(query.body[0].message)),
				JSON.stringify(query)
			);
			assert.ok((await state(nodes[reader], id)).invalidated);
			assert.equal((await state(nodes[0], id)).value.body, 'still resident elsewhere');
		} finally {
			await control(nodes[reader], { residencyFor: id, residents: states[reader].residency });
		}
	});

	test('unreachable residents cause read failures instead of absence or a partial row', async (t) => {
		await put(nodes[0], 'unavailable', { name: 'unavailable', body: 'still exists' });
		const states = await placed('unavailable');
		const residentIndexes = states.flatMap((entry, index) => (entry.invalidated ? [] : [index]));
		const reader = states.findIndex((entry) => entry.invalidated);
		await put(
			nodes[0],
			'partly-unavailable',
			{ name: 'partly-unavailable', body: 'still exists' },
			residentIndexes.map((i) => names[i]).join(',')
		);
		await placed('partly-unavailable');
		await t.test('an empty holder cannot hide the record on a stopped holder', async () => {
			const [emptyHolder, stoppedHolder] = residentIndexes;
			await control(nodes[emptyHolder], { removeLocal: 'partly-unavailable' });
			assert.equal((await state(nodes[emptyHolder], 'partly-unavailable')).present, false);
			const stored = await state(nodes[stoppedHolder], 'partly-unavailable');
			assert.equal(stored.invalidated, false);
			assert.equal(stored.value.body, 'still exists');
			assert.ok((await state(nodes[reader], 'partly-unavailable')).invalidated);
			await control(nodes[reader], { prefer: names[emptyHolder] });
			await put(nodes[emptyHolder], 'partly-empty-probe', { body: 'probe' }, names[emptyHolder]);
			await placed('partly-empty-probe');
			await control(nodes[emptyHolder], { removeLocal: 'partly-empty-probe' });
			await stopNodeProcess(nodes[stoppedHolder]);
			await disconnected(reader, [stoppedHolder]);
			for (let attempt = 0; attempt < 8; attempt++) {
				await waitForCondition(
					async (signal) => (await request(nodes[reader], 'Open/partly-empty-probe', { signal })).status === 404,
					{ timeoutMs: 30_000, description: 'reader receives an empty answer from the surviving holder' }
				);
				const response = await request(nodes[reader], 'Open/partly-unavailable');
				assert.equal(response.status, 502, JSON.stringify(response));
			}
			assert.ok((await state(nodes[reader], 'partly-unavailable')).invalidated);
		});
		await Promise.all(residentIndexes.map((index) => stopNodeProcess(nodes[index])));
		await disconnected(reader, residentIndexes);
		const response = await request(nodes[reader], 'Open/unavailable');
		assert.equal(response.status, 502, JSON.stringify(response));
		const query = await request(nodes[reader], 'Open/?name==unavailable&select(id,body)');
		// Streaming collection responses can commit HTTP headers before a row's loader rejects.
		// Their existing protocol reports an error row; it must never become an empty result.
		assert.ok(
			query.status >= 500 || (query.body.length === 1 && /No connection/.test(query.body[0].message)),
			JSON.stringify(query)
		);
		assert.ok((await state(nodes[reader], 'unavailable')).invalidated);
	});
});
