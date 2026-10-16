/**
 * With `replication.threads`, every replication socket (the replication port's inbound listener and
 * every outbound subscription) is owned by a `replication` pool worker, never an HTTP worker.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const NODE_COUNT = 2;
const POOL_SIZE = 2;

async function threadIds(node, name, signal) {
	const { threads } = await sendOperation(
		node,
		{ operation: 'system_information', attributes: ['threads'] },
		{ signal }
	);
	return threads.filter((thread) => thread.name === name).map((thread) => thread.threadId);
}

async function outboundSocketThreads(node, signal) {
	const { connections } = await sendOperation(node, { operation: 'cluster_status' }, { signal });
	return connections.flatMap((connection) =>
		connection.database_sockets.map((socket) => ({ ...socket, peer: connection.name }))
	);
}

async function allConnected(nodes, signal) {
	for (const node of nodes) {
		const sockets = await outboundSocketThreads(node, signal);
		if (sockets.length === 0 || !sockets.every((socket) => socket.connected)) return false;
	}
	return true;
}

async function readReplicated(node, table, id, signal) {
	const [record] = await sendOperation(
		node,
		{
			operation: 'search_by_id',
			table,
			get_attributes: ['id', 'name'],
			ids: [id],
		},
		{ signal }
	);
	return record;
}

/** The thread type of every log line recording an accepted inbound replication socket. */
async function inboundSocketThreadTypes(node) {
	const log = await readLog(node);
	return log
		.split('\n')
		.filter((line) => line.includes('Incoming replication WS connection received'))
		.map((line) => line.match(/ \[([a-z]+)\/\d+\]/)?.[1]);
}

for (const { label, nodeConfig, nodeEnv } of [
	{
		label: 'explicit replication.threads: 2',
		nodeConfig: (hostname) => ({
			replication: { securePort: hostname + ':9933', threads: POOL_SIZE },
		}),
		nodeEnv: {},
	},
	{
		label: 'omitted replication.threads at threads.count: 4',
		nodeConfig: (hostname) => ({
			threads: { count: 4 },
			replication: { securePort: hostname + ':9933' },
		}),
		nodeEnv: { HARPER_CONFIG: '' },
	},
]) {
	suite(`replication runs on the dedicated worker pool (${label})`, (ctx) => {
		before(async () => {
			const started = await Promise.allSettled(
				Array.from({ length: NODE_COUNT }, async () => {
					const nodeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
					try {
						await startHarper(nodeCtx, {
							config: {
								analytics: { aggregatePeriod: -1 },
								logging: { colors: false, stdStreams: false, console: true, level: 'debug' },
								...nodeConfig(nodeCtx.harper.hostname),
							},
							env: { HARPER_NO_FLUSH_ON_EXIT: true, ...nodeEnv },
						});
					} catch (error) {
						// not yet in ctx.nodes, so release the reserved address (and any data root) here
						await teardownHarper(nodeCtx).catch(() => {});
						throw error;
					}
					return nodeCtx.harper;
				})
			);
			// a node that did start must still reach after()'s teardown when its sibling failed
			ctx.nodes = started.filter((result) => result.status === 'fulfilled').map((result) => result.value);
			const failed = started.find((result) => result.status === 'rejected');
			if (failed) throw failed.reason;
			for (const node of ctx.nodes) {
				await sendOperation(node, {
					operation: 'create_table',
					table: 'pooled',
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'name', type: 'String' },
					],
				});
			}
			const { operation_token: token } = await sendOperation(ctx.nodes[0], {
				operation: 'create_authentication_tokens',
				authorization: ctx.nodes[0].admin,
			});
			await sendOperation(ctx.nodes[1], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				authorization: 'Bearer ' + token,
			});
			await waitForCondition((signal) => allConnected(ctx.nodes, signal), { description: 'the cluster to connect' });
		});

		after(async () => {
			if (ctx.nodes) await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
		});

		test('starts the pool beside the HTTP workers', async () => {
			for (const node of ctx.nodes) strictEqual((await threadIds(node, 'replication')).length, POOL_SIZE);
		});

		test('every outbound subscription is owned by a pool worker', async () => {
			for (const node of ctx.nodes) {
				const pool = await threadIds(node, 'replication');
				const sockets = await outboundSocketThreads(node);
				ok(sockets.length > 0, 'the node subscribes to its peer');
				for (const socket of sockets)
					ok(
						pool.includes(socket.threadId),
						`${socket.peer}/${socket.database} is on thread ${socket.threadId}, not the pool ${pool}`
					);
			}
		});

		test('every inbound replication socket is accepted by a pool worker', async () => {
			for (const node of ctx.nodes) {
				const types = await inboundSocketThreadTypes(node);
				ok(types.length > 0, 'the node accepted its peer’s subscriptions');
				ok(
					types.every((type) => type === 'replication'),
					`inbound replication sockets were accepted on: ${types}`
				);
			}
		});

		test('replicates writes, including to a table created after the pool started', async () => {
			await sendOperation(ctx.nodes[0], {
				operation: 'upsert',
				table: 'pooled',
				records: [{ id: '1', name: 'first' }],
				replicatedConfirmation: 1,
			});
			const record = await waitForCondition((signal) => readReplicated(ctx.nodes[1], 'pooled', '1', signal), {
				timeoutMs: 30000,
				description: 'the write to replicate',
			});
			strictEqual(record.name, 'first');
		});

		test('reconnects on a replaced pool after an operator restart', async () => {
			const node = ctx.nodes[1];
			const before = await threadIds(node, 'replication');
			await sendOperation(node, { operation: 'restart_service', service: 'http_workers' });
			const replaced = await waitForCondition(
				async (signal) => {
					const pool = await threadIds(node, 'replication', signal);
					return pool.length === POOL_SIZE && pool.every((id) => !before.includes(id)) && pool;
				},
				{ timeoutMs: 60000, description: 'the pool to be replaced' }
			);
			await waitForCondition(
				async (signal) => {
					const sockets = await outboundSocketThreads(node, signal);
					return (
						sockets.length > 0 && sockets.every((socket) => socket.connected && replaced.includes(socket.threadId))
					);
				},
				{ timeoutMs: 60000, description: 'subscriptions to move to the new pool and reconnect' }
			);
			await sendOperation(ctx.nodes[0], {
				operation: 'upsert',
				table: 'pooled',
				records: [{ id: '2', name: 'after restart' }],
			});
			const record = await waitForCondition((signal) => readReplicated(node, 'pooled', '2', signal), {
				timeoutMs: 30000,
				description: 'a write after the restart to replicate',
			});
			strictEqual(record.name, 'after restart');
		});
	});
}

async function startResidencyCluster(suiteName, replicationConfig) {
	const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const started = await Promise.allSettled(
		Array.from({ length: NODE_COUNT }, async () => {
			const hostname = await getNextAvailableLoopbackAddress();
			const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
			const compDir = join(dataRootDir, 'components', 'residency-app');
			await mkdir(compDir, { recursive: true });
			await writeFile(
				join(compDir, 'config.yaml'),
				"rest: true\ngraphqlSchema:\n  files: '*.graphql'\njsResource:\n  files: resources.js\n"
			);
			await writeFile(
				join(compDir, 'schema.graphql'),
				'type Sharded @table @export {\n\tid: ID @primaryKey\n\ttag: String @indexed\n\tbody: String\n}\n'
			);
			await writeFile(
				join(compDir, 'resources.js'),
				"tables.Sharded.setResidencyById((id) => (String(id).startsWith('only-on-') ? [String(id).slice('only-on-'.length)] : undefined));\n"
			);
			const nodeCtx = { name: suiteName, harper: { hostname, dataRootDir } };
			try {
				await startHarper(nodeCtx, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: false, console: true, level: 'debug' },
						threads: { count: 4 },
						replication: { securePort: hostname + ':9933', ...replicationConfig },
					},
					env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_CONFIG: '' },
				});
			} catch (error) {
				await teardownHarper(nodeCtx).catch(() => {});
				throw error;
			}
			return nodeCtx.harper;
		})
	);
	const nodes = started.filter((result) => result.status === 'fulfilled').map((result) => result.value);
	const failed = started.find((result) => result.status === 'rejected');
	if (failed) {
		await Promise.all(nodes.map((node) => teardownHarper({ harper: node }).catch(() => {})));
		throw failed.reason;
	}
	const { operation_token: token } = await sendOperation(nodes[0], {
		operation: 'create_authentication_tokens',
		authorization: nodes[0].admin,
	});
	await sendOperation(nodes[1], {
		operation: 'add_node',
		rejectUnauthorized: false,
		hostname: nodes[0].hostname,
		authorization: 'Bearer ' + token,
	});
	await waitForCondition((signal) => allConnected(nodes, signal), { description: 'the cluster to connect' });
	return nodes;
}

async function putSharded(node, record) {
	const response = await fetch(`${node.httpURL}/Sharded/${encodeURIComponent(record.id)}`, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
		},
		body: JSON.stringify(record),
	});
	ok(response.status < 300, `PUT /Sharded/${record.id} failed with status ${response.status}`);
}

suite('setResidencyById migration when replication.threads is defaulted vs explicitly 0', (ctx) => {
	before(async () => {
		ctx.nodes = await startResidencyCluster(ctx.name, {});
	});

	after(async () => {
		if (ctx.nodes) await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('logs a setResidencyById error and stores residency partials on non-resident peers when the pool is active', async () => {
		const [writer, peer] = ctx.nodes;
		const { node_name: writerName } = await sendOperation(writer, { operation: 'cluster_status' });
		await waitForCondition(
			async () => {
				const log = await readLog(writer);
				return (
					log.includes("Table 'Sharded' registered setResidencyById while the replication worker pool is active") &&
					log.includes('Set replication.threads: 0')
				);
			},
			{ timeoutMs: 30000, description: 'setResidencyById pool error in writer log' }
		);

		const localOnlyId = `only-on-${writerName}`;
		await putSharded(writer, { id: localOnlyId, tag: 'pooled-partial', body: 'resident-only' });
		await putSharded(writer, { id: 'shared-after-partial', tag: 'shared', body: 'everywhere' });

		await waitForCondition(
			async (signal) => {
				const [record] = await sendOperation(
					peer,
					{
						operation: 'search_by_id',
						table: 'Sharded',
						ids: ['shared-after-partial'],
						get_attributes: ['id', 'body'],
					},
					{ signal }
				);
				return record?.body === 'everywhere';
			},
			{ timeoutMs: 30000, description: 'subsequent shared write to replicate to peer' }
		);

		const partials = await sendOperation(peer, {
			operation: 'search_by_value',
			table: 'Sharded',
			search_attribute: 'id',
			search_value: localOnlyId,
			get_attributes: ['tag', 'body'],
		});
		strictEqual(partials.length, 1);
		strictEqual(partials[0].tag, 'pooled-partial');
		strictEqual(partials[0].body, null);
	});

	test('explicit replication.threads: 0 at threads.count: 4 runs on HTTP workers and omits non-resident setResidencyById records', async () => {
		const nodes = await startResidencyCluster(`${ctx.name}-opt-out`, { threads: 0 });
		try {
			const [writer, peer] = nodes;
			for (const node of nodes) {
				strictEqual((await threadIds(node, 'http')).length, 4);
				strictEqual((await threadIds(node, 'replication')).length, 0);
			}
			const writerLog = await readLog(writer);
			ok(
				!writerLog.includes("Table 'Sharded' registered setResidencyById while the replication worker pool is active"),
				'no setResidencyById pool error when replication.threads is explicitly 0'
			);

			const { node_name: writerName } = await sendOperation(writer, { operation: 'cluster_status' });
			const localOnlyId = `only-on-${writerName}`;
			await putSharded(writer, { id: localOnlyId, tag: 'opt-out-omitted', body: 'resident-only' });
			await putSharded(writer, { id: 'shared-after-omitted', tag: 'shared', body: 'everywhere' });

			await waitForCondition(
				async (signal) => {
					const [record] = await sendOperation(
						peer,
						{
							operation: 'search_by_id',
							table: 'Sharded',
							ids: ['shared-after-omitted'],
							get_attributes: ['id', 'body'],
						},
						{ signal }
					);
					return record?.body === 'everywhere';
				},
				{ timeoutMs: 30000, description: 'subsequent shared write to replicate to peer' }
			);

			const partials = await sendOperation(peer, {
				operation: 'search_by_value',
				table: 'Sharded',
				search_attribute: 'id',
				search_value: localOnlyId,
				get_attributes: ['tag', 'body'],
			});
			strictEqual(partials.length, 0, 'non-resident peer stores no partial when replication.threads: 0');
		} finally {
			await Promise.all(nodes.map((node) => teardownHarper({ harper: node }).catch(() => {})));
		}
	});
});
