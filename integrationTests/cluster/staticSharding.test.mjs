import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { basename, join } from 'node:path';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startHarper, killHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	sendOperation,
	readNodePid,
	restartNode,
	stopAndTeardownNodes,
	waitForCondition,
	readLog,
} from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const FIXTURE = join(import.meta.dirname, 'fixture-static-sharding');
const SHARDS = [0, 0, 1, 1];
const POOL = JSON.parse(process.env.HARPER_CONFIG || '{}').replication?.threads > 0;

function optionsFor(node, shard) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, level: 'warn' },
			replication: {
				securePort: node.hostname + ':9933',
				shard,
				databases: ['system', 'data', { name: 'shard_data', sharded: true }],
			},
		},
	};
}

async function request(node, path, { method = 'GET', body, local = false, signal = AbortSignal.timeout(30_000) } = {}) {
	const response = await fetch(`${node.httpURL}/${path}`, {
		method,
		headers: {
			'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
			'Content-Type': 'application/json',
			...(local ? { 'X-Replicate-From': 'none' } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal,
	});
	const text = await response.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = text;
	}
	return { status: response.status, data };
}

async function get(node, path, options) {
	const response = await request(node, path, options);
	assert.equal(response.status, 200, JSON.stringify(response));
	return response.data;
}

async function waitForRecord(node, id) {
	let record;
	await waitForCondition(
		async (signal) => {
			const response = await request(node, `Sharded/${id}`, { signal });
			if (response.status !== 200) return false;
			record = response.data;
			return true;
		},
		{ description: `retrieval connection to serve ${id} after owner restart` }
	);
	assert.deepEqual(record, recordFor(id));
}

function recordFor(id, tag = id) {
	return { id, tag, body: id, sequence: 42, details: { label: 'nested', values: [1, false, null, 'value'] } };
}

async function put(node, id, tag = id, table = 'Sharded', extra) {
	const body = table === 'Sharded' ? recordFor(id, tag) : { id, tag, body: id };
	const response = await request(node, `${table}/${id}`, { method: 'PUT', body: { ...body, ...extra } });
	assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response));
}

async function localRows(node, ids, database = 'data', table = 'Sharded', signal = AbortSignal.timeout(30_000)) {
	return sendOperation(
		node,
		{ operation: 'search_by_id', database, table, ids, get_attributes: ['*'], replicateFrom: false },
		{ signal }
	);
}

async function waitForRows(node, ids, database = 'data', table = 'Sharded') {
	await waitForCondition(
		async (signal) => {
			const rows = await localRows(node, ids, database, table, signal);
			return rows.length === ids.length && rows.every((row) => row.body === row.id);
		},
		{ description: `${node.hostname} to hold ${ids.join(', ')}` }
	);
}

async function rawRows(node, table = 'Sharded') {
	return get(node, `LocalRows/?table=${table}`);
}

suite(`Static sharding (replication pool ${POOL ? 'on' : 'off'})`, { timeout: 600_000 }, (ctx) => {
	const contexts = SHARDS.map(() => ({ name: ctx.name }));
	const nodes = () => contexts.map((context) => context.harper);
	let barrierNumber = 0;

	async function mesh() {
		await waitForCondition(
			async (signal) => {
				const statuses = await Promise.all(
					nodes().map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal }).catch(() => null))
				);
				return statuses.every(
					(status) =>
						status?.connections.length === 3 &&
						status.connections.every((connection) =>
							connection.database_sockets.some((socket) => socket.database === 'data' && socket.connected)
						)
				);
			},
			{ description: 'all data replication sockets connected' }
		);
	}

	async function barriers(writers = nodes()) {
		for (const writer of writers) {
			const id = `barrier-${barrierNumber++}`;
			await put(writer, id, id, 'Barrier');
			await waitForCondition(
				async (signal) =>
					(await Promise.all(nodes().map((node) => localRows(node, [id], 'data', 'Barrier', signal)))).every(
						(rows) => rows.length === 1
					),
				{
					description: `${id} from ${writer.hostname} on every node`,
				}
			);
		}
	}

	async function checkNonowners(ids, nonowners) {
		for (const node of nonowners) {
			const raw = (await rawRows(node)).filter((row) => ids.includes(row.id));
			if (POOL) {
				// Pool workers lack application hooks and send indexed invalidations (#980).
				assert.deepEqual(raw.map((row) => row.id).sort(), [...ids].sort());
				assert.ok(
					raw.every((row) => row.record?.body === undefined),
					JSON.stringify(raw)
				);
			} else {
				assert.deepEqual(raw, [], `${node.hostname} stored a nonowned key`);
				assert.deepEqual(await localRows(node, ids), []);
			}
		}
	}

	before(async () => {
		const started = await Promise.allSettled(
			contexts.map(async (context, i) => {
				context.harper = { hostname: await getNextAvailableLoopbackAddress() };
				context.harper.dataRootDir = await mkdtemp(
					join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
				);
				await cp(FIXTURE, join(context.harper.dataRootDir, 'components', basename(FIXTURE)), { recursive: true });
				await startHarper(context, optionsFor(context.harper, SHARDS[i]));
				await sendOperation(context.harper, { operation: 'create_database', database: 'shard_data' });
				await sendOperation(context.harper, {
					operation: 'create_table',
					database: 'shard_data',
					table: 'Rows',
					primary_key: 'id',
				});
				const bad = await request(context.harper, 'Sharded/99:startup', {
					method: 'PUT',
					body: { id: '99:startup', body: 'rejected' },
				});
				assert.ok(bad.status >= 400 && bad.status < 600, JSON.stringify(bad));
				assert.match(JSON.stringify(bad.data), /Shard 99 is not defined/);
				assert.deepEqual(await rawRows(context.harper), []);
			})
		);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		const [seed, ...peers] = nodes();
		const { operation_token: token } = await sendOperation(seed, {
			operation: 'create_authentication_tokens',
			authorization: seed.admin,
		});
		for (const peer of peers)
			await sendOperation(peer, {
				operation: 'add_node',
				hostname: seed.hostname,
				authorization: 'Bearer ' + token,
				rejectUnauthorized: false,
			});
		await mesh();
		for (let i = 0; i < 4; i++) {
			const id = `${SHARDS[i]}:warmup-${i}`;
			await put(nodes()[i], id);
			await waitForRows(nodes()[i ^ 1], [id]);
		}
		await barriers();
	});

	after(() => stopAndTeardownNodes(nodes()));

	test('owner writes stay on their shard; local probes see record-based invalidations', async () => {
		for (const shard of [0, 1]) {
			const owners = nodes().filter((_, i) => SHARDS[i] === shard);
			const nonowners = nodes().filter((_, i) => SHARDS[i] !== shard);
			const ids = [0, 1, 2, 3, 4].map((i) => `${shard}:placement-${i}`);
			for (const id of ids) await put(owners[0], id, 'placement');
			await Promise.all(owners.map((node) => waitForRows(node, ids)));
			await barriers(owners);
			await checkNonowners(ids, nonowners);
			assert.equal((await get(owners[1], `Sharded/${ids[0]}`, { local: true })).body, ids[0]);
			assert.deepEqual(await get(nonowners[0], `Sharded/${ids[0]}`), recordFor(ids[0], 'placement'));
			await checkNonowners(ids, nonowners);
		}
		const homes = nodes()
			.slice(0, 2)
			.map((node) => node.hostname);
		await put(nodes()[0], 'control', 'control', 'Placed', { homes });
		await waitForRows(nodes()[1], ['control'], 'data', 'Placed');
		await barriers(nodes().slice(0, 2));
		for (const node of nodes().slice(2)) {
			const [stub] = (await rawRows(node, 'Placed')).filter((row) => row.id === 'control');
			assert.equal(stub?.record.tag, 'control');
			assert.equal(stub?.record.body, undefined);
		}
	});

	test('sharded databases have only same-shard subscriptions and data', async () => {
		for (const [i, node] of nodes().entries()) {
			await sendOperation(node, {
				operation: 'insert',
				database: 'shard_data',
				table: 'Rows',
				records: [{ id: `db-${i}`, body: `db-${i}` }],
			});
		}
		for (const [i, node] of nodes().entries())
			await waitForRows(node, [`db-${i}`, `db-${i ^ 1}`], 'shard_data', 'Rows');
		await barriers();
		for (const [i, node] of nodes().entries()) {
			const status = await sendOperation(node, { operation: 'cluster_status' });
			const sockets = status.connections.filter((connection) =>
				connection.database_sockets.some((socket) => socket.database === 'shard_data')
			);
			assert.deepEqual(
				sockets.map((socket) => socket.name),
				[nodes()[i ^ 1].hostname]
			);
			assert.ok(sockets[0].database_sockets.find((socket) => socket.database === 'shard_data').connected);
			const rows = await localRows(node, ['db-0', 'db-1', 'db-2', 'db-3'], 'shard_data', 'Rows');
			assert.deepEqual(rows.map((row) => row.id).sort(), [`db-${i}`, `db-${i ^ 1}`].sort());
		}
	});

	test('a nonowner write executes locally and reaches owners without forwarding (#3133)', async () => {
		const id = '0:nonowner-write';
		await put(nodes()[2], id);
		await Promise.all(
			nodes()
				.slice(0, 2)
				.map((node) => waitForRows(node, [id]))
		);
		await barriers();
		// The originating HTTP worker omits the row, including in pool mode. Only
		// the other nonowner can receive an invalidation from the origin's log.
		assert.ok(!(await rawRows(nodes()[2])).some((row) => row.id === id));
		assert.deepEqual(await localRows(nodes()[2], [id]), []);
		await checkNonowners([id], [nodes()[3]]);
		assert.equal((await get(nodes()[3], `Sharded/${id}`)).body, id);
	});

	test('limit queries load complete rows from pooled stubs without changing placement (#198, #980)', async () => {
		const ids = [0, 1, 2, 3, 4].map((i) => `0:limit-${i}`);
		for (const id of ids) await put(nodes()[0], id, 'limit');
		await waitForRows(nodes()[1], ids);
		await barriers(nodes().slice(0, 2));
		const owner = await get(nodes()[0], 'Sharded/?tag=limit&limit(3)');
		assert.equal(owner.length, 3);
		assert.ok(owner.every((row) => ids.includes(row.id)));
		const nonowners = nodes().slice(2);
		const query = 'Sharded/?tag=limit&limit(3)';
		const snapshot = () =>
			Promise.all(nonowners.map(async (node) => (await rawRows(node)).filter((row) => ids.includes(row.id))));
		await checkNonowners(ids, nonowners);
		const before = await snapshot();
		const residents = nodes()
			.slice(0, 2)
			.map((node) => node.hostname)
			.sort();
		for (const rows of before) {
			assert.deepEqual(rows.map((row) => row.id).sort(), POOL ? [...ids].sort() : []);
			if (POOL) {
				for (const row of rows) {
					assert.equal(row.invalidated, true);
					assert.ok(row.residencyId > 0);
					assert.deepEqual([...row.residency].sort(), residents);
				}
			}
		}
		for (const node of nonowners) assert.deepEqual(await get(node, query, { local: true }), []);
		if (POOL)
			for (const id of ids) assert.deepStrictEqual(await get(nonowners[0], `SettledReads/${id}`), { settled: 0 });
		const remote = await get(nonowners[0], query);
		if (POOL) {
			assert.equal(remote.length, 3);
			assert.equal(new Set(remote.map((row) => row.id)).size, 3);
			for (const row of remote) {
				assert.ok(ids.includes(row.id));
				assert.deepStrictEqual(row, recordFor(row.id, 'limit'));
			}
			await waitForCondition(
				async (signal) =>
					(await Promise.all(remote.map((row) => get(nonowners[0], `SettledReads/${row.id}`, { signal })))).every(
						({ settled }) => settled > 0
					),
				{ description: 'replica storage attempts for the returned rows to finish' }
			);
		} else assert.deepEqual(remote, []);
		assert.deepEqual(await snapshot(), before);
		await barriers();
		assert.deepEqual(await snapshot(), before);
		for (const node of nonowners) assert.deepEqual(await get(node, query, { local: true }), []);
		assert.equal((await get(nodes()[2], `Sharded/${ids[4]}`)).body, ids[4]);
	});

	test('operations-API writes retain rows outside their shard, on every node with the pool (#257, #980)', async () => {
		const id = '0:operations-write';
		await sendOperation(nodes()[2], {
			operation: 'insert',
			database: 'data',
			table: 'Sharded',
			records: [{ id, body: id }],
		});
		await Promise.all(
			nodes()
				.slice(0, POOL ? 4 : 3)
				.map((node) => waitForRows(node, [id]))
		);
		await barriers();
		if (POOL) {
			assert.equal((await rawRows(nodes()[3])).find((row) => row.id === id)?.record.body, id);
		} else {
			await checkNonowners([id], [nodes()[3]]);
		}
	});

	test('unknown shards fail without writes and duplicate POST does not crash (#257, #199)', async () => {
		const node = nodes()[0];
		const pid = await readNodePid(node);
		const bad = await request(node, 'Sharded/99:missing', {
			method: 'PUT',
			body: { id: '99:missing', body: 'rejected' },
		});
		assert.ok(bad.status >= 400 && bad.status < 600, JSON.stringify(bad));
		assert.match(JSON.stringify(bad.data), /Shard 99 is not defined/);
		await put(node, '0:duplicate');
		const duplicate = await request(node, 'Sharded/', {
			method: 'POST',
			body: { id: '0:duplicate', body: 'replacement' },
		});
		assert.equal(duplicate.status, 409, JSON.stringify(duplicate));
		assert.equal((await get(node, 'Sharded/0:duplicate')).body, '0:duplicate');
		await barriers();
		for (const peer of nodes()) assert.ok(!(await rawRows(peer)).some((row) => row.id.startsWith('99:')));
		assert.equal(await readNodePid(node), pid);
	});

	test('repeated remote and missing-id reads preserve residency and do not self-connect (#197, #200, #201)', async () => {
		const pids = await Promise.all(nodes().map(readNodePid));
		await put(nodes()[0], '0:other-table', 'other', 'OtherSharded');
		await waitForRows(nodes()[1], ['0:other-table'], 'data', 'OtherSharded');
		for (let i = 0; i < 20; i++) {
			assert.equal((await get(nodes()[2], 'Sharded/0:placement-1')).body, '0:placement-1');
			assert.equal((await get(nodes()[2], 'OtherSharded/0:other-table')).body, '0:other-table');
			const missing = await request(nodes()[2], `Sharded/0:missing-${i}`);
			assert.equal(missing.status, 404, JSON.stringify(missing));
		}
		assert.deepEqual(await Promise.all(nodes().map(readNodePid)), pids);
		for (const node of nodes()) {
			const status = await sendOperation(node, { operation: 'cluster_status' });
			assert.equal(status.connections.length, 3);
			assert.ok(status.connections.every((connection) => connection.name !== status.node_name));
			assert.doesNotMatch(
				await readLog(node),
				/Should not connect to self|Cannot read properties of undefined \(reading 'match'\)/
			);
		}
	});

	test('an owner peer serves cold reads during downtime and the restarted owner catches up', async () => {
		const [owner, peer, reader] = nodes();
		await put(owner, '0:failover');
		await put(owner, '0:other-owner');
		await waitForRows(peer, ['0:failover', '0:other-owner']);
		await killHarper(contexts[0]);
		try {
			await waitForRecord(reader, '0:failover');
			await put(peer, '0:during-downtime');
		} finally {
			await startHarper(contexts[0], optionsFor(owner, 0));
		}
		await mesh();
		await waitForRows(contexts[0].harper, ['0:during-downtime']);
		await killHarper(contexts[1]);
		try {
			await waitForRecord(reader, '0:other-owner');
		} finally {
			await startHarper(contexts[1], optionsFor(peer, 0));
		}
		await mesh();
		const newPid = await restartNode(contexts[0].harper);
		await put(contexts[1].harper, '0:during-restart');
		await mesh();
		await waitForRows(contexts[0].harper, ['0:during-downtime', '0:during-restart']);
		await waitForRecord(reader, '0:during-restart');
		await barriers();
		await checkNonowners(['0:during-downtime', '0:during-restart'], nodes().slice(2));
		assert.equal(await readNodePid(contexts[0].harper), newPid);
	});
});
