import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { basename, join } from 'node:path';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT =
	process.env.HARPER_SLOT_BASELINE_INSTALL_SCRIPT || join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const FIXTURE = join(import.meta.dirname, 'fixture-slot-residency');
const SHARDS = [0, 0, 1, 1];
const POOL = JSON.parse(process.env.HARPER_CONFIG || '{}').replication?.threads > 0;

async function request(node, path, { method = 'GET', body, signal = AbortSignal.timeout(30_000) } = {}) {
	const response = await fetch(`${node.httpURL}/${path}`, {
		method,
		signal,
		headers: {
			'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
			'Content-Type': 'application/json',
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
async function get(node, path, signal) {
	const response = await request(node, path, { signal });
	assert.equal(response.status, 200, JSON.stringify(response));
	return response.data;
}
async function put(node, table, body) {
	const response = await request(node, `${table}/${body.id}`, { method: 'PUT', body });
	assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response));
}
const rawRows = (node, table, signal) => get(node, `SlotLocalRows/?table=${table}`, signal);

suite(`Declarative residency (replication pool ${POOL ? 'on' : 'off'})`, { timeout: 600_000 }, (ctx) => {
	const contexts = SHARDS.map(() => ({ name: ctx.name }));
	const nodes = () => contexts.map((context) => context.harper);
	let barrier = 0;
	async function barriers() {
		for (const writer of nodes()) {
			const id = `barrier-${barrier++}`;
			await put(writer, 'SlotBarrier', { id });
			await waitForCondition(
				async (signal) =>
					(
						await Promise.all(
							nodes().map((node) =>
								sendOperation(
									node,
									{
										operation: 'search_by_id',
										database: 'data',
										table: 'SlotBarrier',
										ids: [id],
										get_attributes: ['*'],
									},
									{ signal }
								)
							)
						)
					).every((rows) => rows.length === 1),
				{ description: `${id} received by every node` }
			);
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
				await startHarper(context, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: false, level: 'warn' },
						replication: {
							securePort: context.harper.hostname + ':9933',
							shard: SHARDS[i],
							shards: [1, 0],
							databases: '*',
						},
					},
				});
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
		await waitForCondition(
			async (signal) =>
				(
					await Promise.all(nodes().map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal })))
				).every(
					(status) =>
						status.connections.length === 3 &&
						status.connections.every((connection) =>
							connection.database_sockets.some((socket) => socket.database === 'data' && socket.connected)
						)
				),
			{ description: 'four-node declarative residency mesh connected' }
		);
		await barriers();
	});
	after(() => stopAndTeardownNodes(nodes()));

	async function checkPlacement(table, id, slot, body) {
		await waitForCondition(
			async (signal) => {
				const rows = await Promise.all(nodes().map((node) => rawRows(node, table, signal)));
				return rows.every((entries, i) => {
					const entry = entries.find((entry) => entry.id === id);
					return SHARDS[i] === slot % 2
						? entry?.record?.body === body
						: table === 'SlotNoIndex'
							? true
							: Boolean(entry?.record);
				});
			},
			{ description: `${table}/${id} stored only by shard ${slot % 2}` }
		);
		await barriers();
		for (const [i, node] of nodes().entries()) {
			const entry = (await rawRows(node, table)).find((entry) => entry.id === id);
			if (SHARDS[i] === slot % 2) assert.equal(entry.record.body, body);
			else if (table === 'SlotNoIndex') assert.equal(entry?.record, undefined);
			else {
				assert.equal(entry.record.body, undefined);
				assert.ok(entry.flags & 1);
			}
			assert.equal(entry?.residencyId, undefined);
			assert.equal(entry?.slot, table === 'SlotAttributes' ? slot : undefined);
		}
	}

	test('main-thread operations inserts obey declarative placement on non-owners', async () => {
		const result = await sendOperation(nodes()[0], {
			operation: 'insert',
			database: 'data',
			table: 'SlotKeys',
			records: [{ id: 'operation1', tag: 'ops', body: 'from operations' }],
		});
		assert.equal(result.inserted_hashes.length, 1);
		await checkPlacement('SlotKeys', 'operation1', 1, 'from operations');
	});

	test('default hash and key expressions agree across all threads and nodes', async () => {
		for (const table of ['SlotKeys', 'SlotHash', 'SlotNoIndex']) {
			const id = 'remote1';
			const policies = await Promise.all(nodes().map((node) => get(node, `SlotPolicy/?table=${table}&id=${id}`)));
			assert.ok(policies.every((policy) => policy.slot === policies[0].slot));
			const writer = nodes()[SHARDS.findIndex((shard) => shard !== policies[0].slot % 2)];
			await put(writer, table, { id, tag: 'remote', body: 'routed' });
			await checkPlacement(table, id, policies[0].slot, 'routed');
		}
	});

	test('cold reads proxy to owners and indexed replicas stay non-authoritative', async () => {
		await put(nodes()[0], 'SlotKeys', { id: 'cached1', tag: 'old', body: 'original' });
		await checkPlacement('SlotKeys', 'cached1', 1, 'original');
		assert.equal((await get(nodes()[0], 'SlotKeys/cached1')).body, 'original');
		await waitForCondition(
			async (signal) =>
				(await rawRows(nodes()[0], 'SlotKeys', signal)).some(
					(row) => row.id === 'cached1' && row.record.body === 'original'
				),
			{ description: 'indexed non-owner caches its successful owner read' }
		);
		const replica = (await rawRows(nodes()[0], 'SlotKeys')).find((row) => row.id === 'cached1');
		assert.equal(replica.residencyId, undefined);
		assert.equal(replica.slot, undefined);
		await put(nodes()[2], 'SlotKeys', { id: 'cached1', tag: 'new', body: 'updated' });
		await checkPlacement('SlotKeys', 'cached1', 1, 'updated');
		await put(nodes()[2], 'SlotNoIndex', { id: 'cold1', body: 'only owners' });
		await checkPlacement('SlotNoIndex', 'cold1', 1, 'only owners');
		assert.equal((await get(nodes()[0], 'SlotNoIndex/cold1')).body, 'only owners');
		assert.equal(
			(await rawRows(nodes()[0], 'SlotNoIndex')).some((row) => row.id === 'cold1' && row.record),
			false
		);
	});

	test('attribute-slot changes transfer the complete body and invalidate former owners', async () => {
		await put(nodes()[0], 'SlotAttributes', { id: 'moving', region: 0, tag: 'before', body: 'complete body' });
		await checkPlacement('SlotAttributes', 'moving', 0, 'complete body');
		const response = await request(nodes()[0], 'SlotAttributes/moving', {
			method: 'PATCH',
			body: { region: 1, tag: 'after' },
		});
		assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response));
		await checkPlacement('SlotAttributes', 'moving', 1, 'complete body');
		const fromStub = await request(nodes()[1], 'SlotAttributes/moving', {
			method: 'PATCH',
			body: { region: 0, tag: 'back' },
		});
		assert.ok(fromStub.status >= 200 && fromStub.status < 300, JSON.stringify(fromStub));
		await checkPlacement('SlotAttributes', 'moving', 0, 'complete body');
		for (const node of nodes()) assert.equal((await get(node, 'SlotAttributes/moving')).body, 'complete body');
	});
});

suite('Declarative residency with mismatched shard lists', { timeout: 300_000 }, (ctx) => {
	const contexts = [0, 1].map(() => ({ name: ctx.name }));
	const nodes = () => contexts.map((context) => context.harper);
	before(async () => {
		for (const [i, context] of contexts.entries()) {
			context.harper = { hostname: await getNextAvailableLoopbackAddress() };
			context.harper.dataRootDir = await mkdtemp(
				join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
			);
			await cp(FIXTURE, join(context.harper.dataRootDir, 'components', basename(FIXTURE)), { recursive: true });
			await startHarper(context, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, level: 'warn' },
					replication: {
						securePort: context.harper.hostname + ':9933',
						shard: i,
						shards: i ? [0, 1, 2] : [0, 1],
						databases: '*',
					},
				},
			});
		}
		const [seed, peer] = nodes();
		const { operation_token: token } = await sendOperation(seed, {
			operation: 'create_authentication_tokens',
			authorization: seed.admin,
		});
		await sendOperation(peer, {
			operation: 'add_node',
			hostname: seed.hostname,
			authorization: 'Bearer ' + token,
			rejectUnauthorized: false,
		});
	});
	after(() => stopAndTeardownNodes(nodes()));
	test('different lists block declarative writes on both nodes and report the cause', async () => {
		await waitForCondition(
			async (signal) =>
				(
					await Promise.all(nodes().map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal })))
				).every(
					(status) =>
						status.residency?.data?.blocked &&
						status.residency.data.errors.some((error) => error.includes('replication.shards differs'))
				),
			{ description: 'both nodes report shard-list disagreement' }
		);
		for (const [i, node] of nodes().entries()) {
			const body = { id: `blocked${i}`, tag: 'blocked', body: 'must not be placed' };
			const result = await request(node, `SlotKeys/${body.id}`, { method: 'PUT', body });
			assert.equal(result.status, 503, JSON.stringify(result));
			assert.match(JSON.stringify(result.data), /replication.shards differs/);
			assert.equal(
				(await rawRows(node, 'SlotKeys')).some((row) => row.id === body.id && row.record),
				false
			);
		}
	});
});
