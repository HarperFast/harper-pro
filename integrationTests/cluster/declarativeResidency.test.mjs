import { attributeSlotsSkip, attributeSlotsAvailable, prepareSlotFixture } from './experimentalSharding.mjs';
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { basename, join } from 'node:path';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	sendOperation,
	stopAndTeardownNodes,
	waitForCondition,
	readNodePid,
	stopNodeProcess,
	postOperation,
} from './clusterShared.mjs';

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

suite(`Sharding (replication pool ${POOL ? 'on' : 'off'})`, { timeout: 600_000 }, (ctx) => {
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
				await prepareSlotFixture(join(context.harper.dataRootDir, 'components', basename(FIXTURE)));
				await startHarper(context, {
					config: {
						storage: { rocks: { transactionLogAbortMarkers: true } },
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: false, level: 'warn' },
						replication: {
							experimentalAttributeSlots: true,
							securePort: context.harper.hostname + ':9933',
							shard: SHARDS[i],
							shards: [1, 0],
							pingInterval: 500,
							pingTimeout: 3000,
							confirmationTimeout: 2000,
							shardingConfirmationTimeout: 15000,
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
			{ description: 'four-node sharding mesh connected' }
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
			else if (entry.flags & 4) assert.equal(entry.record.body, body);
			else {
				assert.equal(entry.record.body, undefined);
				assert.ok(entry.flags & 1);
			}
			assert.equal(entry?.residencyId, undefined);
			assert.equal(entry?.slot, ['SlotAttributes', 'SlotTenant', 'SlotRegional'].includes(table) ? slot : undefined);
		}
	}

	test(
		'hashes string and numeric tenant values identically on every node and preserves affinity',
		{ skip: attributeSlotsSkip },
		async () => {
			for (const value of ['tenant-a', 42]) {
				const placement = await Promise.all(
					nodes().map((node) =>
						get(node, `SlotPolicy/?table=SlotTenant&id=probe&value=${encodeURIComponent(JSON.stringify(value))}`)
					)
				);
				const slot = placement[0].slot;
				assert.ok(placement.every((entry) => entry.slot === slot && entry.policy.slots === 10));
				if (typeof value === 'string') {
					const keyPlacement = await Promise.all(
						nodes().map((node) => get(node, `SlotPolicy/?table=SlotHash&id=${encodeURIComponent(value)}`))
					);
					assert.ok(
						keyPlacement.every((entry) => entry.slot === slot),
						'key and attribute values use the same hash'
					);
				}
				for (const [index, writer] of nodes().entries()) {
					const id = `tenant-${value}-${index}`;
					await put(writer, 'SlotTenant', { id, tenantId: value, body: id });
					await checkPlacement('SlotTenant', id, slot, id);
				}
			}
		}
	);

	test(
		'compiled region expressions select separate logical slots and shards on every node',
		{ skip: attributeSlotsSkip },
		async () => {
			for (const [region, slot] of [
				['asia', 1],
				['europe', 2],
			]) {
				const placement = await Promise.all(
					nodes().map((node) =>
						get(node, `SlotPolicy/?table=SlotRegional&id=probe&value=${encodeURIComponent(JSON.stringify(region))}`)
					)
				);
				assert.ok(placement.every((entry) => entry.slot === slot));
				for (const [index, writer] of nodes().entries()) {
					const id = `region-${region}-${index}`;
					await put(writer, 'SlotRegional', { id, region, body: id });
					await checkPlacement('SlotRegional', id, slot, id);
				}
			}
		}
	);

	test('initialization retries and legacy placement comparison work through the operations API', async () => {
		const ranges = Array.from({ length: 10 }, (_, start) => ({ start, end: start + 1, shard: start % 2 }));
		const installed = await sendOperation(nodes()[0], {
			operation: 'initialize_shard_map',
			database: 'data',
			slots: 10,
			ranges,
		});
		const retry = await sendOperation(nodes()[1], {
			operation: 'initialize_shard_map',
			database: 'data',
			slots: 10,
			ranges,
		});
		assert.equal(retry.digest, installed.digest);
		assert.equal(retry.version, installed.version);
		await put(nodes()[0], 'SlotLegacy', { id: 'legacy0', body: 'shard-zero' });
		await put(nodes()[2], 'SlotLegacy', { id: 'legacy1', body: 'shard-one' });
		await barriers();
		for (const node of nodes()) {
			const result = await sendOperation(node, {
				operation: 'verify_shard_map',
				database: 'data',
				table: 'SlotLegacy',
				policy: { slots: 10, slotFrom: 'Number(id.slice(-1))' },
			});
			assert.ok(result.checked > 0);
			assert.equal(result.mismatches, 0);
			assert.equal(result.mapDigest, installed.digest);
		}
	});

	test(
		'attribute puts and confirmed handoffs transfer file-backed blob contents',
		{ skip: attributeSlotsSkip },
		async () => {
			const id = 'file-backed-handoff';
			const expected = await get(nodes()[0], `SlotBlobSeed/${id}`);
			async function verify(node, region, signal) {
				const actual = await get(node, `SlotBlobLocalDigest/${id}`, signal);
				return actual.digest === expected.digest && actual.region === region;
			}
			await waitForCondition((signal) => verify(nodes()[1], 0, signal), {
				description: 'original owner has the actual replicated blob bytes',
			});
			const response = await request(nodes()[0], `SlotBlob/${id}`, { method: 'PATCH', body: { region: 1 } });
			if (response.status >= 300)
				console.error('Blob handoff failed', {
					response,
					owners: await Promise.all(
						nodes()
							.slice(2)
							.map((node) => get(node, `SlotBlobLocalDigest/${id}`))
					),
				});
			assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response));
			await waitForCondition(
				async (signal) =>
					(
						await Promise.all(
							nodes()
								.slice(2)
								.map((node) => verify(node, 1, signal))
						)
					).every(Boolean),
				{
					description: 'new owners have the confirmed blob bytes',
				}
			);
		}
	);

	test(
		'a frozen new owner is refused before commit and a local replica does not confirm a committed move',
		{ skip: attributeSlotsSkip },
		async () => {
			const writer = nodes()[0];
			const owners = nodes().slice(2);
			const pids = await Promise.all(owners.map(readNodePid));
			for (const pid of pids) assert.ok(Number.isInteger(pid));
			const id = 'bounded-move';
			await put(writer, 'SlotAttributes', { id, region: 0, tag: 'before', body: 'must reach the owner' });
			await barriers();
			try {
				for (const pid of pids) process.kill(pid, 'SIGSTOP');
				await waitForCondition(
					async (signal) => {
						const status = await sendOperation(writer, { operation: 'cluster_status' }, { signal });
						const ownerConnections = status.connections.filter((connection) =>
							owners.some((owner) => owner.hostname === connection.node_name || owner.hostname === connection.name)
						);
						return (
							ownerConnections.length === owners.length &&
							ownerConnections.every(
								(connection) =>
									!connection.database_sockets.some((socket) => socket.database === 'data' && socket.connected)
							)
						);
					},
					{ timeoutMs: 15000, description: 'frozen owners lose their data subscriptions' }
				);
				const refused = await request(writer, `SlotAttributes/${id}`, {
					method: 'PATCH',
					body: { region: 1 },
					signal: AbortSignal.timeout(8000),
				});
				assert.equal(refused.status, 503, JSON.stringify(refused));
				assert.equal((await rawRows(writer, 'SlotAttributes')).find((row) => row.id === id).record.region, 0);
			} finally {
				for (const pid of pids) process.kill(pid, 'SIGCONT');
			}
			await barriers();
			const armed = await request(writer, 'SlotFreezeOnCommit/', { method: 'POST', body: { id, pids } });
			assert.equal(armed.status, 200, JSON.stringify(armed));
			assert.deepEqual(armed.data, { armed: true, id, pids });
			const started = Date.now();
			try {
				const uncertain = await request(writer, `SlotAttributes/${id}`, {
					method: 'PATCH',
					body: { region: 1 },
					signal: AbortSignal.timeout(25000),
				});
				assert.equal(
					uncertain.status,
					504,
					JSON.stringify({ uncertain, freeze: await get(writer, 'SlotFreezeOnCommit/') })
				);
				assert.equal(uncertain.data.replicationUnconfirmed, true);
				assert.equal(uncertain.data.retryable, false);
				assert.match(uncertain.data.title, /15000ms/);
				assert.ok(Date.now() - started < 22000);
				const local = (await rawRows(writer, 'SlotAttributes')).find((row) => row.id === id);
				assert.ok(local.flags & 4, 'committed writer body is a replica');
				assert.equal((await get(writer, `SlotAttributes/${id}`)).body, 'must reach the owner');
			} finally {
				for (const pid of pids) process.kill(pid, 'SIGCONT');
			}
			await waitForCondition(
				async (signal) =>
					(await Promise.all(owners.map((node) => rawRows(node, 'SlotAttributes', signal)))).every((rows) =>
						rows.some((row) => row.id === id && row.record?.region === 1 && row.record?.body === 'must reach the owner')
					),
				{ description: 'recovered owners receive the complete committed body' }
			);
			await put(writer, 'SlotAttributes', { id, region: 0, tag: 'reset', body: 'confirmed body' });
			await barriers();
			const confirmed = await request(writer, `SlotAttributes/${id}`, { method: 'PATCH', body: { region: 1 } });
			assert.ok(confirmed.status >= 200 && confirmed.status < 300, JSON.stringify(confirmed));
			assert.ok(
				(await Promise.all(owners.map((node) => rawRows(node, 'SlotAttributes')))).some((rows) =>
					rows.some((row) => row.id === id && row.record?.body === 'confirmed body' && row.record?.region === 1)
				),
				'2xx follows a real owner body'
			);
		}
	);

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
		await put(nodes()[2], 'SlotKeys', { id: 'cached1', tag: 'old', body: 'original' });
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

	test(
		'attribute-slot changes transfer the complete body and invalidate former owners',
		{ skip: attributeSlotsSkip },
		async () => {
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
		}
	);

	test('non-owner deletes reach owners with key, attribute, and index-free policies', async () => {
		for (const table of ['SlotKeys', ...(attributeSlotsAvailable ? ['SlotAttributes'] : []), 'SlotNoIndex']) {
			const id = 'delete1';
			await put(nodes()[0], table, { id, region: 1, tag: 'deleted', body: 'remove everywhere' });
			await checkPlacement(table, id, 1, 'remove everywhere');
			const response = await request(nodes()[1], `${table}/${id}`, { method: 'DELETE' });
			assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response));
			await waitForCondition(
				async (signal) =>
					(await Promise.all(nodes().map((node) => rawRows(node, table, signal)))).every(
						(rows) => !rows.some((row) => row.id === id && row.record)
					),
				{ description: `${table}/${id} deleted from every owner and stub holder` }
			);
		}
	});
});

suite('Sharding with mismatched shard lists', { timeout: 300_000 }, (ctx) => {
	const contexts = [0, 1].map(() => ({ name: ctx.name }));
	const nodes = () => contexts.map((context) => context.harper);
	before(async () => {
		for (const [i, context] of contexts.entries()) {
			context.harper = { hostname: await getNextAvailableLoopbackAddress() };
			context.harper.dataRootDir = await mkdtemp(
				join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
			);
			await cp(FIXTURE, join(context.harper.dataRootDir, 'components', basename(FIXTURE)), { recursive: true });
			await prepareSlotFixture(join(context.harper.dataRootDir, 'components', basename(FIXTURE)));
			await startHarper(context, {
				config: {
					storage: { rocks: { transactionLogAbortMarkers: true } },
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, level: 'warn' },
					replication: {
						experimentalAttributeSlots: true,
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
						status.sharding?.data?.blocked &&
						status.sharding.data.errors.some((error) => error.includes('replication.shards differs'))
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

suite('Sharding quarantine on restart', { timeout: 300_000, skip: attributeSlotsSkip }, (ctx) => {
	const context = { name: ctx.name };
	const peerContext = { name: ctx.name };
	async function prepare(target) {
		target.harper = { hostname: await getNextAvailableLoopbackAddress() };
		target.harper.dataRootDir = await mkdtemp(
			join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
		);
		await cp(FIXTURE, join(target.harper.dataRootDir, 'components', basename(FIXTURE)), { recursive: true });
		await prepareSlotFixture(join(target.harper.dataRootDir, 'components', basename(FIXTURE)));
	}
	async function start(shards, target = context, shard = 0) {
		await startHarper(target, {
			config: {
				storage: { rocks: { transactionLogAbortMarkers: true } },
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, level: 'warn' },
				replication: {
					experimentalAttributeSlots: true,
					securePort: target.harper.hostname + ':9933',
					shard,
					shards,
					databases: '*',
				},
			},
		});
	}
	before(async () => {
		await prepare(context);
		await prepare(peerContext);
		await start([0, 1]);
		await start([0, 1], peerContext, 1);
		const { operation_token: token } = await sendOperation(context.harper, {
			operation: 'create_authentication_tokens',
			authorization: context.harper.admin,
		});
		await sendOperation(peerContext.harper, {
			operation: 'add_node',
			hostname: context.harper.hostname,
			authorization: 'Bearer ' + token,
			rejectUnauthorized: false,
		});
		await waitForCondition(
			async (signal) =>
				(
					await request(context.harper, 'SlotAttributes/quarantine-ready', {
						method: 'PUT',
						body: { id: 'quarantine-ready', region: 0 },
						signal,
					})
				).status === 204,
			{ description: 'canonical shard membership is visible' }
		);
	});
	after(() => stopAndTeardownNodes([context.harper, peerContext.harper]));
	test('serves healthy data and operations while the invalid database stays fenced until repair and restart', async () => {
		await put(context.harper, 'SlotAttributes', { id: 'quarantined', region: 0, body: 'preserved' });
		await sendOperation(context.harper, { operation: 'create_database', database: 'healthy' });
		await sendOperation(context.harper, {
			operation: 'create_table',
			database: 'healthy',
			table: 'Rows',
			primary_key: 'id',
		});
		await sendOperation(context.harper, {
			operation: 'insert',
			database: 'healthy',
			table: 'Rows',
			records: [{ id: 'good', body: 'available' }],
		});
		await waitForCondition(
			async (signal) =>
				(await rawRows(peerContext.harper, 'SlotAttributes', signal)).some((row) => row.id === 'quarantined'),
			{ description: 'peer has the original slot projection' }
		);
		// Establish this direction's durable resume cursor before queuing the held write. Otherwise
		// restart bootstraps a primary-store copy, which intentionally cannot promote a non-owner's
		// replica to an authoritative body; this case exercises audit-tail resume through quarantine.
		await put(peerContext.harper, 'SlotAttributes', { id: 'inbound-ready', region: 1, body: 'peer-owned' });
		await waitForCondition(
			async (signal) =>
				(await rawRows(context.harper, 'SlotAttributes', signal)).some((row) => row.id === 'inbound-ready'),
			{ description: 'writer has received the peer audit stream' }
		);
		// A copied row and a positive received watermark can precede copy finalization. Rewrite an
		// already received key, then require its live tail and removal of the durable copy cursor.
		await put(peerContext.harper, 'SlotAttributes', {
			id: 'inbound-ready',
			region: 1,
			tag: 'live-tail',
			body: 'peer-owned',
		});
		await waitForCondition(
			async (signal) => {
				const resume = await get(
					context.harper,
					`SlotReplicationResume/?node=${encodeURIComponent(peerContext.harper.hostname)}`,
					signal
				);
				return (
					resume.seqId > 0 &&
					!resume.copying &&
					(await rawRows(context.harper, 'SlotAttributes', signal)).some(
						(row) => row.id === 'inbound-ready' && row.record?.tag === 'live-tail'
					)
				);
			},
			{ description: 'writer has finished the initial copy and received the peer live tail' }
		);
		const before = (await rawRows(context.harper, 'SlotAttributes')).find((row) => row.id === 'quarantined');
		const priorPid = await readNodePid(context.harper);
		await stopNodeProcess(context.harper);
		await put(peerContext.harper, 'SlotAttributes', { id: 'quarantined', region: 0, body: 'delayed peer write' });
		const quarantineStarted = Date.now();
		await start([1]);
		assert.notEqual(await readNodePid(context.harper), priorPid);
		const node = context.harper;
		const status = await sendOperation(node, { operation: 'cluster_status' });
		assert.equal(status.sharding.data.blocked, true);
		assert.match(status.sharding.data.errors.join(' '), /replication.shard/);
		const rows = await sendOperation(node, {
			operation: 'search_by_id',
			database: 'healthy',
			table: 'Rows',
			ids: ['good'],
			get_attributes: ['*'],
		});
		assert.equal(rows[0].body, 'available');
		await sendOperation(node, {
			operation: 'insert',
			database: 'healthy',
			table: 'Rows',
			records: [{ id: 'still', body: 'serving' }],
		});
		for (const operation of [
			{
				operation: 'search_by_id',
				database: 'data',
				table: 'SlotAttributes',
				ids: ['quarantined'],
				get_attributes: ['*'],
			},
			{
				operation: 'update',
				database: 'data',
				table: 'SlotAttributes',
				records: [{ id: 'quarantined', body: 'forbidden' }],
			},
		]) {
			const response = await postOperation(node, operation);
			assert.equal(response.status, 503, JSON.stringify(response));
			assert.match(JSON.stringify(response.body), /replication.shard/);
		}
		for (const method of ['GET', 'PATCH']) {
			const response = await request(node, 'SlotAttributes/quarantined', {
				method,
				...(method === 'PATCH' ? { body: { body: 'forbidden' } } : {}),
			});
			assert.equal(response.status, 503, JSON.stringify(response));
			assert.match(JSON.stringify(response.data), /replication.shard/);
		}
		await waitForCondition(
			async (signal) => {
				const status = await sendOperation(peerContext.harper, { operation: 'cluster_status' }, { signal });
				return status.connections
					.find((connection) => connection.name === node.hostname)
					?.database_sockets.some(
						(socket) =>
							socket.database === 'data' &&
							socket.lastConnectionError?.code === 1011 &&
							Date.parse(socket.lastConnectionError.time) >= quarantineStarted
					);
			},
			{ description: 'peer observes a refused data connection after the quarantined restart' }
		);
		assert.deepEqual(
			(await rawRows(node, 'SlotAttributes')).find((row) => row.id === 'quarantined'),
			before,
			'no apply while quarantined'
		);
		await stopNodeProcess(node);
		await start([0, 1]);
		await waitForCondition(
			async (signal) => {
				const response = await request(context.harper, 'SlotAttributes/quarantined', { signal });
				assert.ok([200, 502, 503].includes(response.status), JSON.stringify(response));
				return response.status === 200 && response.data.body === 'delayed peer write';
			},
			{ description: 'repaired database resumes the held peer write' }
		);
		// A complete read hit is available before the origin-admission coordinator finishes.
		// Both must recover, but receiving the held row does not order the status transition.
		await waitForCondition(
			async (signal) => {
				const status = await sendOperation(context.harper, { operation: 'cluster_status' }, { signal });
				return status.sharding.data.blocked === false;
			},
			{ description: 'repaired database reopens sharded write admission' }
		);
	});
});
