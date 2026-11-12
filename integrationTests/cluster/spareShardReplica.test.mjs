import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { cp, mkdtemp } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { readLog, sendOperation, stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const FIXTURE = join(import.meta.dirname, 'fixture-clone-sharded');
const SECOND_FIXTURE = join(import.meta.dirname, 'fixture-spare-second');
const SPARES = [1, 2, 3];
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
	let data = text || undefined;
	try {
		data = text ? JSON.parse(text) : undefined;
	} catch {}
	return { status: response.status, data };
}

async function localRows(node, signal) {
	const { status, data } = await rest(node, 'CloneLocalRows', { signal });
	assert.equal(status, 200, JSON.stringify(data));
	return data.sort((a, b) => a.id.localeCompare(b.id));
}

async function mapShards(node, database, signal) {
	const [map] = await sendOperation(
		node,
		{
			operation: 'search_by_id',
			database: 'system',
			table: 'hdb_residency_slots',
			ids: [database],
			get_attributes: ['ranges'],
		},
		{ signal }
	);
	return map && [...new Set(map.ranges.map((range) => range.shard))].sort();
}

const clusterStatus = (node, signal) => sendOperation(node, { operation: 'cluster_status' }, { signal });

const availability = async (node, signal) =>
	(await sendOperation(node, { operation: 'get_status', id: 'availability' }, { signal }).catch(() => undefined))
		?.status;

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
		await waitForCondition(async (signal) => (await availability(node, signal)) === 'Available', {
			timeoutMs: 180_000,
			description: `${node.hostname} to become Available`,
		});
		await waitForCondition(
			async (signal) => (await sendOperation(node, { operation: 'get_configuration' }, { signal })).cloned === true,
			{ timeoutMs: 180_000, description: `${node.hostname} to finish its clone` }
		);
		return node;
	}

	// The leader activates the default map and the others install it from replication: three first activations at
	// once is a separate race, not what this suite is about.
	async function deployOnLeaderFirst(fixture, database) {
		const [leader, ...others] = backbone;
		await cp(fixture, join(leader.dataRootDir, 'components', basename(fixture)), { recursive: true });
		await sendOperation(leader, { operation: 'restart_service', service: 'http_workers' });
		await waitForCondition(
			async (signal) =>
				(await Promise.all(others.map((node) => mapShards(node, database, signal).catch(() => undefined)))).every(
					(shards) => shards !== undefined
				),
			{ timeoutMs: 180_000, description: `the ${database} map to reach every backbone node` }
		);
		for (const node of others) {
			await cp(fixture, join(node.dataRootDir, 'components', basename(fixture)), { recursive: true });
			await sendOperation(node, { operation: 'restart_service', service: 'http_workers' });
		}
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
				config: nodeConfig(context.harper.hostname, { shard: 0, shards: SHARDS, spareShards: SPARES, databases: '*' }),
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
		await deployOnLeaderFirst(FIXTURE, 'data');
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
			await waitForCondition(
				async (signal) => {
					const { status } = await rest(leader, `CloneRows/${id}`, {
						method: 'PUT',
						body: { id, body: `body-${i}` },
						signal,
					});
					return status >= 200 && status < 300;
				},
				{ description: `the leader to accept ${id}` }
			);
		}
		for (const node of backbone)
			assert.deepEqual(await mapShards(node, 'data'), [0], `${node.hostname}'s default map gives spares no slots`);
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
		const configuration = (await sendOperation(replica, { operation: 'get_configuration' })).replication;
		assert.equal(configuration.shard, 1);
		assert.deepEqual(configuration.spareShards, SPARES, 'the clone takes the spare list, or it would disagree');
		assert.deepEqual(
			(await localRows(replica)).filter((row) => row.body !== undefined),
			[],
			'it copied no full records'
		);
		const leaderStatus = await clusterStatus(backbone[0]);
		assert.deepEqual(leaderStatus.sharding.data.errors, [], 'the replica did not hold the backbone');
	});

	test('reads through the replica come from the owners, and its writes reach every owner', async () => {
		await waitForCondition(
			async (signal) => {
				for (const row of rows.slice(0, 5)) {
					const { status, data } = await rest(replica, `CloneRows/${row.id}`, { signal });
					if (status !== 200) return false;
					assert.deepEqual(data, row);
				}
				return true;
			},
			{ description: "the replica to serve the owners' rows" }
		);
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
		).catch(async (error) => {
			const views = await Promise.all(
				nodes().map(async (node) => [node.hostname, await rest(node, `CloneRows/${written.id}`).catch(String)])
			);
			const status = await clusterStatus(replica, AbortSignal.timeout(10_000)).catch(String);
			throw new Error(
				`${error.message}; views: ${JSON.stringify(views)}; replica sharding: ${JSON.stringify(status?.sharding?.data)}; replica connections: ${JSON.stringify(status?.connections?.map((peer) => [peer.name, peer.database_sockets?.map((socket) => [socket.database, socket.connected, socket.lastReceivedVersion, socket.lastSentVersion ?? socket.sending])]))}`
			);
		});
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

	test('a database deployed after setup puts no slots on spares, on any node', async () => {
		await deployOnLeaderFirst(SECOND_FIXTURE, 'second');
		await waitForCondition(
			async (signal) =>
				(await Promise.all(nodes().map((node) => mapShards(node, 'second', signal).catch(() => undefined)))).every(
					(shards) => JSON.stringify(shards) === '[0]'
				),
			{ timeoutMs: 180_000, description: "every node to hold the second database's map, all on shard 0" }
		);
		await waitForCondition(
			async (signal) =>
				(await Promise.all(backbone.map((node) => clusterStatus(node, signal).catch(() => undefined)))).every(
					(status) => status?.sharding?.second?.state === 'available'
				),
			{ timeoutMs: 180_000, description: 'the second database to become available on the backbone' }
		);
		const { status, data } = await rest(backbone[0], 'SecondRows/after-setup', {
			method: 'PUT',
			body: { id: 'after-setup', body: 'second database' },
		});
		assert.ok(status >= 200 && status < 300, JSON.stringify(data));
		await waitForCondition(
			async (signal) =>
				(await rest(backbone[1], 'SecondRows/after-setup', { signal })).data?.body === 'second database',
			{ description: 'another owner to hold the second database row' }
		);
	});

	test('a node whose spare list differs is reported by its peers and holds sharded writes until repaired', async () => {
		const [leader, , node] = backbone;
		const differs = (status) =>
			status?.sharding?.data?.errors?.some((error) =>
				error.includes(`replication.shards differs from peer ${node.hostname} (shard or spare list)`)
			);
		await sendOperation(node, { operation: 'set_configuration', replication_spareShards: [1, 2] });
		try {
			await waitForCondition(async (signal) => differs(await clusterStatus(leader, signal)), {
				timeoutMs: 60_000,
				description: 'the leader to report the differing spare list',
			});
			await waitForCondition(
				async (signal) =>
					(
						await rest(node, 'CloneRows/held', {
							method: 'PUT',
							body: { id: 'held', body: 'must not commit' },
							signal,
						})
					).status === 503,
				{ timeoutMs: 60_000, description: 'the node with the differing list to refuse sharded writes' }
			);
		} finally {
			await sendOperation(node, { operation: 'set_configuration', replication_spareShards: SPARES });
		}
		await waitForCondition(async (signal) => !differs(await clusterStatus(leader, signal)), {
			timeoutMs: 60_000,
			description: 'the repaired list to clear the report',
		});
		await waitForCondition(
			async (signal) => {
				const { status } = await rest(node, 'CloneRows/repaired', {
					method: 'PUT',
					body: { id: 'repaired', body: 'after repair' },
					signal,
				});
				return status >= 200 && status < 300;
			},
			{ timeoutMs: 60_000, description: 'sharded writes to resume after the repair' }
		);
	});
});
