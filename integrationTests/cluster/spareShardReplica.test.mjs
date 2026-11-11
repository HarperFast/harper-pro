// A backbone layout: every slot on shard 0, spare IDs listed. Replica nodes join a spare and own nothing.
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { cp, mkdtemp } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { readLog, sendOperation, stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const FIXTURE = join(import.meta.dirname, 'fixture-clone-sharded');
const SHARDS = [0, 1, 2, 3];
const ROW_COUNT = 20;

const nodeConfig = (hostname, replication) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false, stdStreams: false, level: 'warn' },
	replication: { securePort: hostname + ':9933', ...replication },
});
const authorization = (node) =>
	'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64');

async function rest(node, path, { method = 'GET', body, signal = AbortSignal.timeout(30_000) } = {}) {
	const response = await fetch(`${node.httpURL}/${path}`, {
		method,
		signal,
		headers: { 'Authorization': authorization(node), 'Content-Type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	return { status: response.status, data: text ? JSON.parse(text) : undefined };
}

async function localRows(node, signal) {
	const { status, data } = await rest(node, 'CloneLocalRows', { signal });
	assert.equal(status, 200, JSON.stringify(data));
	return data.sort((a, b) => a.id.localeCompare(b.id));
}

const clusterStatus = (node, signal) => sendOperation(node, { operation: 'cluster_status' }, { signal });

const availability = async (node) =>
	(await sendOperation(node, { operation: 'get_status', id: 'availability' }).catch(() => undefined))?.status;

suite('Replica nodes in a spare shard', { timeout: 900_000 }, (ctx) => {
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);
	let backbone;
	let rows;

	async function startClone(env) {
		const context = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		contexts.push(context);
		const leader = backbone[0];
		const { operation_token: token } = await sendOperation(leader, {
			operation: 'create_authentication_tokens',
			authorization: leader.admin,
			expires_in: '15Minutes',
		});
		await startHarper(context, {
			config: nodeConfig(context.harper.hostname),
			env: {
				HDB_LEADER_URL: `http://${leader.hostname}:9925`,
				HDB_LEADER_TOKEN: token,
				ALLOW_SELF_SIGNED: true,
				HARPER_NO_FLUSH_ON_EXIT: true,
				...env,
			},
		});
		const node = context.harper;
		await waitForCondition(async () => (await availability(node)) === 'Available', {
			timeoutMs: 180_000,
			description: `${node.hostname} to become Available`,
		});
		await waitForCondition(
			async () => (await sendOperation(node, { operation: 'get_configuration' })).cloned === true,
			{ timeoutMs: 180_000, description: `${node.hostname} to finish its clone` }
		);
		return node;
	}

	before(async () => {
		for (let i = 0; i < 3; i++) {
			const context = {
				name: ctx.name,
				harper: {
					hostname: await getNextAvailableLoopbackAddress(),
					dataRootDir: await mkdtemp(
						join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
					),
				},
			};
			contexts.push(context);
			await startHarper(context, {
				config: nodeConfig(context.harper.hostname, { shard: 0, shards: SHARDS, databases: '*' }),
			});
		}
		backbone = nodes();
		const [leader, ...others] = backbone;
		for (const node of others) {
			const { operation_token: token } = await sendOperation(leader, {
				operation: 'create_authentication_tokens',
				authorization: leader.admin,
			});
			await sendOperation(node, {
				operation: 'add_node',
				hostname: leader.hostname,
				authorization: 'Bearer ' + token,
				rejectUnauthorized: false,
			});
		}
		await sendOperation(leader, { operation: 'create_database', database: 'data' });
		const { digest } = await sendOperation(leader, {
			operation: 'initialize_shard_map',
			database: 'data',
			slots: 10,
			ranges: [{ start: 0, end: 10, shard: 0 }],
		});
		await waitForCondition(
			async (signal) =>
				(
					await Promise.all(
						others.map((node) =>
							sendOperation(
								node,
								{
									operation: 'search_by_id',
									database: 'system',
									table: 'hdb_residency_slots',
									ids: ['data'],
									get_attributes: ['digest'],
								},
								{ signal }
							)
						)
					)
				).every((answer) => answer[0]?.digest === digest),
			{ description: 'the backbone map to reach every backbone node' }
		);
		for (const node of backbone) {
			await cp(FIXTURE, join(node.dataRootDir, 'components', basename(FIXTURE)), { recursive: true });
			await sendOperation(node, { operation: 'restart_service', service: 'http_workers' });
		}
		await waitForCondition(
			async (signal) =>
				(await Promise.all(backbone.map((node) => clusterStatus(node, signal).catch(() => undefined)))).every(
					(status) =>
						status?.sharding?.data?.state === 'available' &&
						status.connections.filter((peer) =>
							peer.database_sockets.some((socket) => socket.database === 'data' && socket.connected)
						).length ===
							backbone.length - 1
				),
			{ timeoutMs: 180_000, description: 'the backbone to become ready' }
		);
		for (let i = 0; i < ROW_COUNT; i++) {
			const id = `row-${i}`;
			const { status, data } = await rest(leader, `CloneRows/${id}`, {
				method: 'PUT',
				body: { id, body: `body-${i}` },
			});
			assert.ok(status >= 200 && status < 300, JSON.stringify(data));
		}
		await waitForCondition(
			async (signal) => {
				const held = await Promise.all(backbone.map((node) => localRows(node, signal)));
				rows = held[0];
				return held.every((list) => list.length === ROW_COUNT);
			},
			{ description: 'every backbone node to hold every row' }
		);
	});

	after(() => stopAndTeardownNodes(nodes()));

	let replica;

	test('a replica clone joins the lowest spare, reaches Available and owns nothing', async () => {
		replica = await startClone({ CLONE_SHARD: 'replica' });
		assert.match(
			await readLog(replica),
			/Clone shard: shard 1 from "replica"; live members: 0=3, 1=0, 2=0, 3=0; shards owning slots: \[0\]/
		);
		const status = await clusterStatus(replica);
		assert.equal(status.sharding.data.state, 'available', JSON.stringify(status.sharding.data));
		assert.ok(status.sharding.data.nodesOwningNoSlots.includes(replica.hostname), JSON.stringify(status.sharding.data));
		assert.deepEqual(
			status.sharding.data.shards.map(({ shard, slots }) => ({ shard, slots })),
			[{ shard: 0, slots: 10 }]
		);
		assert.equal((await sendOperation(replica, { operation: 'get_configuration' })).replication.shard, 1);
		assert.deepEqual(
			(await localRows(replica)).filter((row) => row.body !== undefined),
			[],
			'it copied no full records'
		);
		const leaderStatus = await clusterStatus(backbone[0]);
		assert.deepEqual(leaderStatus.sharding.data.errors, [], 'the replica did not hold the backbone');
	});

	test('reads through the replica come from the owners, and its writes reach every owner', async () => {
		for (const row of rows.slice(0, 5)) assert.deepEqual((await rest(replica, `CloneRows/${row.id}`)).data, row);
		const written = { id: 'from-replica', body: 'written on a replica' };
		const { status, data } = await rest(replica, `CloneRows/${written.id}`, { method: 'PUT', body: written });
		assert.ok(status >= 200 && status < 300, JSON.stringify(data));
		await waitForCondition(
			async (signal) =>
				(
					await Promise.all(
						backbone.map(async (node) => (await rest(node, `CloneRows/${written.id}`, { signal })).data?.body)
					)
				).every((body) => body === written.body),
			{ description: 'the replica write to reach every owner' }
		);
		assert.deepEqual((await rest(replica, `CloneRows/${written.id}`)).data, written);
	});

	test('a second replica joins the spare the first holds, and "auto" still joins the owning shard', async () => {
		const second = await startClone({ CLONE_SHARD: 'replica' });
		assert.match(await readLog(second), /Clone shard: shard 1 from "replica"; live members: 0=3, 1=1, 2=0, 3=0/);
		const backboneNode = await startClone({ CLONE_SHARD: 'auto' });
		assert.match(await readLog(backboneNode), /Clone shard: shard 0 from "auto"; live members: 0=3, 1=2, 2=0, 3=0/);
		await waitForCondition(async (signal) => (await localRows(backboneNode, signal)).length === ROW_COUNT + 1, {
			description: 'the "auto" clone to hold every row as an owner',
		});
	});
});
