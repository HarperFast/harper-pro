import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { restartNode, sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const ALL_REPLICAS = isLMDB ? '*' : '*;confirm=3';
const replicaTest = isLMDB ? test.skip : test;
const FIXTURE = join(import.meta.dirname, 'fixture-residency-replicas');
const OPEN_REPLICA_EXPIRATION_MS = 4_000;

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

async function put(node, id, body, replicateTo = '1', tableName = 'Open') {
	const result = await request(node, `${tableName}/${id}`, {
		method: 'PUT',
		headers: { 'X-Replicate-To': replicateTo },
		body: JSON.stringify({ id, ...body }),
	});
	assert.ok(result.status < 300, JSON.stringify(result));
	return result;
}

async function state(node, id, signal, tableName = 'Open') {
	const result = await request(node, `ResidencyState/${tableName}:${id}`, { signal });
	assert.equal(result.status, 200, JSON.stringify(result));
	return result.body;
}

suite('local replicas of residency stubs', { timeout: 900_000 }, (ctx) => {
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
		await meshed();
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

	function meshed() {
		return waitForCondition(
			async (signal) => {
				const statuses = await Promise.all(
					nodes.map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal }).catch(() => undefined))
				);
				return statuses.every(
					(status) =>
						status?.connections.length === 3 &&
						status.connections.every((connection) =>
							connection.database_sockets.some((socket) => socket.database === 'data' && socket.connected)
						)
				);
			},
			{ timeoutMs: 120_000, description: 'four-node data mesh' }
		);
	}

	async function placed(id, tableName = 'Open') {
		return waitForCondition(
			async (signal) => {
				const states = await Promise.all(nodes.map((node) => state(node, id, signal, tableName)));
				return states.every((entry) => entry.present) && states;
			},
			{ timeoutMs: 30_000, description: `${id} on every node, including stubs` }
		);
	}

	async function control(node, data) {
		const response = await request(node, 'ResidencyState', {
			method: 'POST',
			body: JSON.stringify(data),
		});
		assert.equal(response.status, 200, JSON.stringify(response));
	}

	async function replicaOn(reader, id, tableName = 'Open') {
		return waitForCondition(
			async (signal) => {
				const current = await state(nodes[reader], id, signal, tableName);
				return current.replica && current;
			},
			{ timeoutMs: 30_000, description: `${id} kept as a replica on ${names[reader]}` }
		);
	}

	async function stubOn(reader, id, tableName = 'Open', timeoutMs = 30_000) {
		return waitForCondition(
			async (signal) => {
				const current = await state(nodes[reader], id, signal, tableName);
				return current.invalidated && !current.replica && current;
			},
			{ timeoutMs, description: `${id} back to a stub on ${names[reader]}` }
		);
	}

	async function placedRecord(id, body, tableName = 'Open') {
		await put(nodes[0], id, { name: id, body }, '1', tableName);
		const states = await placed(id, tableName);
		const full = states.flatMap((entry, index) => (entry.invalidated ? [] : [index]));
		const stubs = states.flatMap((entry, index) => (entry.invalidated ? [index] : []));
		assert.equal(full.length, 2, JSON.stringify(states));
		assert.equal(stubs.length, 2, JSON.stringify(states));
		return { states, full, reader: stubs[0], other: stubs[1] };
	}

	for (const tableName of ['Proxy', ...(isLMDB ? ['Open'] : [])]) {
		test(`a ${tableName} non-resident read stays a proxy without changing placement`, async () => {
			const id = `proxy-${tableName}`;
			const { states: before, full, reader } = await placedRecord(id, 'proxy body', tableName);
			const response = await request(nodes[reader], `${tableName}/${id}`);
			assert.equal(response.status, 200, JSON.stringify(response));
			assert.equal(response.body.body, 'proxy body');
			await waitForCondition(
				async (signal) =>
					(await state(nodes[reader], id, signal, tableName)).storeAttempts > before[reader].storeAttempts,
				{
					timeoutMs: 30_000,
					description: 'the declined replica store to settle',
				}
			);
			const after = await Promise.all(nodes.map((node) => state(node, id, undefined, tableName)));
			for (const [index, entry] of after.entries()) {
				assert.deepEqual(entry.residency, before[index].residency);
				assert.deepEqual(entry.history, before[index].history);
				assert.equal(entry.version, before[index].version);
				assert.equal(entry.invalidated, before[index].invalidated);
				assert.equal(entry.replica, false);
			}
			assert.equal(after[reader].value.body, undefined);
			for (const index of full) await control(nodes[index], { table: tableName, removeLocal: id });
			const missing = await request(nodes[reader], `${tableName}/${id}`);
			assert.equal(missing.status, 404, JSON.stringify(missing));
		});
	}

	replicaTest('a non-resident read keeps a replica and changes no placement, then serves from it alone', async () => {
		const { states: before, full, reader, other } = await placedRecord('kept', 'complete');
		const response = await request(nodes[reader], 'Open/kept');
		assert.equal(response.status, 200, JSON.stringify(response));
		assert.equal(response.body.body, 'complete');
		const replica = await replicaOn(reader, 'kept');
		assert.equal(replica.value.body, 'complete');
		assert.ok(!replica.invalidated);
		assert.equal(replica.expiresAt, null, 'the row carries no replica deadline');
		const after = await Promise.all(nodes.map((node) => state(node, 'kept')));
		for (const [index, entry] of after.entries()) {
			assert.deepEqual(entry.residency, before[index].residency, `${names[index]} residency changed`);
			assert.deepEqual(entry.history, before[index].history, `${names[index]} logged a write for a read`);
			assert.equal(entry.invalidated, index !== reader && before[index].invalidated);
			assert.equal(entry.version, before[index].version);
		}
		assert.ok(after[other].invalidated && !after[other].replica);
		for (const index of full) await control(nodes[index], { removeLocal: 'kept' });
		const served = await request(nodes[reader], 'Open/kept');
		assert.equal(served.status, 200, JSON.stringify(served));
		assert.equal(served.body.body, 'complete');
		const absent = await waitForCondition(
			async (signal) => {
				const result = await request(nodes[other], 'Open/kept', { signal });
				return result.status !== 502 && result;
			},
			{ timeoutMs: 30_000, description: 'the other stub holder to get an answer from the residents' }
		);
		assert.equal(absent.status, 404, JSON.stringify(absent));
	});

	replicaTest('keeps a replica only while the resident head is a full write, and renews it while hot', async () => {
		const id = 'head-kind';
		const { full, reader } = await placedRecord(id, 'put body');
		// every node, so whichever resident the reader asks answers with this write
		const reachedReader = async (description) => {
			const { version } = await state(nodes[full[0]], id);
			const states = await waitForCondition(
				async (signal) => {
					const all = await Promise.all(nodes.map((node) => state(node, id, signal)));
					return all.every((current) => current.version === version) && all;
				},
				{ timeoutMs: 30_000, description }
			);
			return states[reader];
		};
		const patched = await request(nodes[full[0]], `Open/${id}`, {
			method: 'PATCH',
			headers: { 'X-Replicate-To': '1' },
			body: JSON.stringify({ body: 'patched body' }),
		});
		assert.ok(patched.status < 300, JSON.stringify(patched));
		const patchedStub = await reachedReader('the patch to reach the reader as a stub');
		assert.ok(patchedStub.invalidated, JSON.stringify(patchedStub));
		const served = await request(nodes[reader], `Open/${id}`);
		assert.equal(served.body.body, 'patched body');
		const declined = await waitForCondition(
			async (signal) => {
				const current = await state(nodes[reader], id, signal);
				return current.storeAttempts > patchedStub.storeAttempts && current;
			},
			{ timeoutMs: 30_000, description: 'the store attempt for the patch head to settle' }
		);
		assert.ok(declined.invalidated && !declined.replica, `a patch head was kept: ${JSON.stringify(declined)}`);

		await put(nodes[full[0]], id, { name: id, body: 'put again' });
		assert.ok((await reachedReader('the put to reach the reader as a stub')).invalidated);
		assert.equal((await request(nodes[reader], `Open/${id}`)).body.body, 'put again');
		await replicaOn(reader, id);
		const hotUntil = Date.now() + OPEN_REPLICA_EXPIRATION_MS * 2.5;
		while (Date.now() < hotUntil) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			const current = await state(nodes[reader], id);
			assert.ok(current.replica, `the hot replica was demoted: ${JSON.stringify(current)}`);
			await request(nodes[reader], `Open/${id}`);
		}
	});

	replicaTest('a non-resident query materializes rows as replicas', async () => {
		const { reader } = await placedRecord('queried', 'complete query');
		const result = await request(nodes[reader], 'Open/?name==queried&select(id,body)');
		assert.equal(result.status, 200, JSON.stringify(result));
		assert.deepEqual(result.body, [{ id: 'queried', body: 'complete query' }]);
		await replicaOn(reader, 'queried');
	});

	replicaTest(
		'an owner update turns the replica back into a stub and the next read fetches the new version',
		async () => {
			const { full, reader } = await placedRecord('updated', 'first');
			await request(nodes[reader], 'Open/updated');
			await replicaOn(reader, 'updated');
			await put(nodes[full[0]], 'updated', { name: 'updated-2', body: 'second' });
			await put(nodes[full[0]], 'updated-barrier', { body: 'barrier' }, ALL_REPLICAS);
			const stub = await stubOn(reader, 'updated');
			assert.equal(stub.value.name, 'updated-2', 'the stub carries the new indexed value');
			assert.equal(stub.value.body, undefined);
			const response = await request(nodes[reader], 'Open/updated');
			assert.equal(response.status, 200, JSON.stringify(response));
			assert.equal(response.body.body, 'second');
			assert.equal((await replicaOn(reader, 'updated')).value.body, 'second');
		}
	);

	replicaTest('a fetched record older than a stub that landed meanwhile is served but not kept', async () => {
		const { full, reader } = await placedRecord('raced', 'first');
		const attemptsBefore = (await state(nodes[reader], 'raced')).storeAttempts;
		await control(nodes[reader], { holdReplicas: true });
		try {
			const held = await request(nodes[reader], 'Open/raced');
			assert.equal(held.status, 200, JSON.stringify(held));
			assert.equal(held.body.body, 'first', 'the caller receives what the resident answered');
			await put(nodes[full[0]], 'raced', { name: 'raced-2', body: 'second' });
			await put(nodes[full[0]], 'raced-barrier', { body: 'barrier' }, ALL_REPLICAS);
			await waitForCondition(
				async (signal) => (await state(nodes[reader], 'raced', signal)).value?.name === 'raced-2',
				{
					timeoutMs: 30_000,
					description: 'the newer stub to land while the fetched record is held',
				}
			);
		} finally {
			await control(nodes[reader], { holdReplicas: false });
		}
		const current = await waitForCondition(
			async (signal) => {
				const now = await state(nodes[reader], 'raced', signal);
				return now.storeAttempts > attemptsBefore && now;
			},
			{ timeoutMs: 30_000, description: 'the held store attempt to settle' }
		);
		assert.ok(current.invalidated && !current.replica, `stale fetched record was kept: ${JSON.stringify(current)}`);
		assert.equal(current.value.name, 'raced-2');
		const response = await request(nodes[reader], 'Open/raced');
		assert.equal(response.body.body, 'second');
		assert.equal((await replicaOn(reader, 'raced')).value.body, 'second');
	});

	replicaTest('a replica expires back to a stub with no replicated write', async () => {
		const { states: before, reader } = await placedRecord('expiring', 'complete');
		await request(nodes[reader], 'Open/expiring');
		await replicaOn(reader, 'expiring');
		const stub = await stubOn(reader, 'expiring', 'Open', OPEN_REPLICA_EXPIRATION_MS * 5);
		assert.equal(stub.value.name, 'expiring');
		assert.equal(stub.value.body, undefined);
		assert.deepEqual(stub.residency, before[reader].residency);
		assert.equal(stub.version, before[reader].version);
		const after = await Promise.all(nodes.map((node) => state(node, 'expiring')));
		for (const [index, entry] of after.entries())
			assert.deepEqual(entry.history, before[index].history, `${names[index]} logged the eviction`);
		const response = await request(nodes[reader], 'Open/expiring');
		assert.equal(response.body.body, 'complete');
	});

	// LMDB has no replicatedConfirmation feasibility refusal (see residencyConfirmation.test.mjs)
	replicaTest('replicatedConfirmation never counts a replica holder', { skip: isLMDB }, async () => {
		const { full, reader } = await placedRecord('confirmed', 'complete');
		await request(nodes[reader], 'Open/confirmed');
		await replicaOn(reader, 'confirmed');
		const refused = await request(nodes[full[0]], 'Open/confirmed', {
			method: 'PUT',
			headers: { 'X-Replicate-To': '1;confirm=2' },
			body: JSON.stringify({ id: 'confirmed', name: 'confirmed', body: 'refused' }),
		});
		assert.equal(refused.status, 400, JSON.stringify(refused));
		await put(nodes[full[0]], 'confirmed', { name: 'confirmed', body: 'confirmed once' }, '1;confirm=1');
	});

	replicaTest('a replica survives a restart and stays subject to its lifetime', async () => {
		const kept = await placedRecord('restarted-kept', 'kept body', 'Kept');
		const reader = kept.reader;
		// an Open record the restarted node reads as a stub, whatever the placement function picks
		let openId;
		for (let attempt = 0; openId === undefined && attempt < 12; attempt++) {
			const id = `restarted-${attempt}`;
			const open = await placedRecord(id, 'open body');
			if ([open.reader, open.other].includes(reader)) openId = id;
		}
		assert.ok(openId, 'no Open record placed away from the restarted node');
		await request(nodes[reader], 'Kept/restarted-kept');
		const keptReplica = await replicaOn(reader, 'restarted-kept', 'Kept');
		await request(nodes[reader], `Open/${openId}`);
		await replicaOn(reader, openId);
		await restartNode(nodes[reader], { timeoutMs: 120_000 });
		await waitForCondition(
			async (signal) => {
				try {
					return (await state(nodes[reader], 'restarted-kept', signal, 'Kept')).present;
				} catch {
					return false;
				}
			},
			{ timeoutMs: 120_000, description: `${names[reader]} to answer after its restart` }
		);
		const afterRestart = await state(nodes[reader], 'restarted-kept', undefined, 'Kept');
		assert.ok(afterRestart.replica, `the replica did not survive the restart: ${JSON.stringify(afterRestart)}`);
		assert.equal(afterRestart.version, keptReplica.version);
		assert.equal(afterRestart.value.body, 'kept body');
		const stub = await stubOn(reader, openId, 'Open', OPEN_REPLICA_EXPIRATION_MS * 5);
		assert.equal(stub.value.body, undefined, 'the sweep re-armed at load must demote the expired replica');
		await meshed();
	});
});
