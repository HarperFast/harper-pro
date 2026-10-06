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

suite('replication runs on the dedicated worker pool', (ctx) => {
	before(async () => {
		ctx.nodes = await Promise.all(
			Array.from({ length: NODE_COUNT }, async () => {
				const nodeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
				await startHarper(nodeCtx, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: false, console: true, level: 'debug' },
						replication: { securePort: nodeCtx.harper.hostname + ':9933', threads: POOL_SIZE },
					},
					env: { HARPER_NO_FLUSH_ON_EXIT: true },
				});
				return nodeCtx.harper;
			})
		);
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
				return sockets.length > 0 && sockets.every((socket) => socket.connected && replaced.includes(socket.threadId));
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
