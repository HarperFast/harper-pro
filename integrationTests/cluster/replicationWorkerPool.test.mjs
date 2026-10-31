/**
 * With `replication.threads` explicitly set, or defaulted to `Math.floor(threads.count / 2)` for
 * `threads.count >= 2` and no deprecated hook registered, every replication socket (the replication
 * port's inbound listener and every outbound subscription) is owned by a `replication` pool worker. Also covers
 * the port-fallback to 0 pool workers and `setResidencyById` behavior per `replication.threads` setting.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendOperation, readLog, restartNode, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

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

for (const { label, nodeConfig } of [
	{
		label: 'explicit replication.threads: 2',
		nodeConfig: (hostname) => ({
			replication: { securePort: hostname + ':9933', threads: POOL_SIZE },
		}),
	},
	{
		label: 'omitted replication.threads at threads.count: 4',
		nodeConfig: (hostname) => ({
			threads: { count: 4 },
			replication: { securePort: hostname + ':9933' },
		}),
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
							env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_CONFIG: '' },
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

async function teardownResidencyCluster(nodes) {
	await Promise.all(
		nodes.map(async (node) => {
			await stopNodeProcess(node).catch(() => {});
			await teardownHarper({ harper: node }).catch(() => {});
		})
	);
}

async function startResidencyCluster(suiteName, replicationConfig) {
	const started = await Promise.allSettled(
		Array.from({ length: NODE_COUNT }, async () => {
			const hostname = await getNextAvailableLoopbackAddress();
			const nodeCtx = { name: suiteName, harper: { hostname } };
			try {
				nodeCtx.harper = { hostname, dataRootDir: await mkdtemp(join(tmpdir(), 'harper-integration-test-')) };
				const compDir = join(nodeCtx.harper.dataRootDir, 'components', 'residency-app');
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
		await teardownResidencyCluster(nodes);
		throw failed.reason;
	}
	try {
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
	} catch (error) {
		await teardownResidencyCluster(nodes);
		throw error;
	}
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

const SET_RESIDENCY_BY_ID_DEPRECATION =
	"Table 'data.Sharded' registered setResidencyById, which is deprecated as of Harper 5.4";

async function assertResidencyHookOmitsNonResidentPeer(nodes, tag) {
	const [writer, peer] = nodes;
	const { node_name: writerName } = await sendOperation(writer, { operation: 'cluster_status' });
	const localOnlyId = `only-on-${writerName}`;
	await putSharded(writer, { id: localOnlyId, tag, body: 'resident-only' });
	await putSharded(writer, { id: `shared-after-${tag}`, tag: 'shared', body: 'everywhere' });

	await waitForCondition(
		async (signal) => {
			const [record] = await sendOperation(
				peer,
				{
					operation: 'search_by_id',
					table: 'Sharded',
					ids: [`shared-after-${tag}`],
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
	strictEqual(partials.length, 0, 'the non-resident peer stores nothing for a record the hook excludes it from');
	const byTag = await sendOperation(peer, {
		operation: 'search_by_value',
		table: 'Sharded',
		search_attribute: 'tag',
		search_value: tag,
		get_attributes: ['id'],
	});
	strictEqual(byTag.length, 0, 'the indexed value of an excluded record never reaches the non-resident peer');
}

suite('setResidencyById with an explicit, defaulted, or explicitly 0 replication.threads', (ctx) => {
	test('explicit replication.threads: 2 logs a setResidencyById error and stores residency partials on non-resident peers', async () => {
		let nodes;
		try {
			nodes = await startResidencyCluster(`${ctx.name}-explicit`, { threads: POOL_SIZE });
			const [writer, peer] = nodes;
			const { node_name: writerName } = await sendOperation(writer, { operation: 'cluster_status' });
			await waitForCondition(
				async () => {
					const log = await readLog(writer);
					return log.includes(SET_RESIDENCY_BY_ID_DEPRECATION) && log.includes('set replication.threads: 0');
				},
				{ timeoutMs: 30000, description: 'setResidencyById deprecation warning in writer log' }
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
		} finally {
			if (nodes) await teardownResidencyCluster(nodes);
		}
	});

	test('omitted replication.threads at threads.count: 4 starts no pool and omits non-resident setResidencyById records', async () => {
		let nodes;
		try {
			nodes = await startResidencyCluster(`${ctx.name}-defaulted`, {});
			for (const node of nodes) {
				strictEqual((await threadIds(node, 'http')).length, 4);
				strictEqual((await threadIds(node, 'replication')).length, 0);
				const log = await readLog(node);
				ok(log.includes(SET_RESIDENCY_BY_ID_DEPRECATION), 'registering the hook logs its deprecation');
				ok(
					/Starting no replication pool: replication\.threads is not set and data\.Sharded/.test(log),
					'the defaulted pool is declined, naming the table'
				);
			}
			await assertResidencyHookOmitsNonResidentPeer(nodes, 'defaulted-omitted');
		} finally {
			if (nodes) await teardownResidencyCluster(nodes);
		}
	});

	test('explicit replication.threads: 0 at threads.count: 4 runs on HTTP workers and omits non-resident setResidencyById records', async () => {
		let nodes;
		try {
			nodes = await startResidencyCluster(`${ctx.name}-opt-out`, { threads: 0 });
			const [writer] = nodes;
			for (const node of nodes) {
				strictEqual((await threadIds(node, 'http')).length, 4);
				strictEqual((await threadIds(node, 'replication')).length, 0);
			}
			const writerLog = await readLog(writer);
			ok(writerLog.includes(SET_RESIDENCY_BY_ID_DEPRECATION), 'the deprecation is logged whether or not a pool runs');
			ok(!writerLog.includes('Starting no replication pool'), 'an explicit 0 has no pool to decline');

			await assertResidencyHookOmitsNonResidentPeer(nodes, 'opt-out-omitted');
		} finally {
			if (nodes) await teardownResidencyCluster(nodes);
		}
	});
});

suite('defaulted replication.threads port fallback', (ctx) => {
	test('falls back to 0 pool workers across restart when no replication port is configured', async () => {
		const hostname = await getNextAvailableLoopbackAddress();
		const nodeCtx = { name: `${ctx.name}-no-port`, harper: { hostname } };
		try {
			await startHarper(nodeCtx, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, console: true, level: 'warn' },
					threads: { count: 4 },
					replication: { port: null, securePort: null },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_CONFIG: '' },
			});
			strictEqual((await threadIds(nodeCtx.harper, 'http')).length, 4);
			strictEqual((await threadIds(nodeCtx.harper, 'replication')).length, 0);

			// Restart to prove validateConfig did not persist the defaulted replication.threads
			// into harper-config.yaml and cause a second-boot throw.
			await restartNode(nodeCtx.harper);
			await waitForCondition(
				async (signal) => {
					try {
						const http = await threadIds(nodeCtx.harper, 'http', signal);
						const repl = await threadIds(nodeCtx.harper, 'replication', signal);
						return http.length === 4 && repl.length === 0;
					} catch {
						return false;
					}
				},
				{ timeoutMs: 30000, description: 'restarted node to come back with 4 HTTP and 0 replication workers' }
			);
		} finally {
			if (nodeCtx.harper?.dataRootDir) await stopNodeProcess(nodeCtx.harper).catch(() => {});
			await teardownHarper(nodeCtx).catch(() => {});
		}
	});

	test('falls back to 0 pool workers when replication.port shares the operations API port', async () => {
		const hostname = await getNextAvailableLoopbackAddress();
		const nodeCtx = { name: `${ctx.name}-shared-ops-port`, harper: { hostname } };
		try {
			await startHarper(nodeCtx, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, console: true, level: 'warn' },
					threads: { count: 4 },
					replication: { port: hostname + ':9925', securePort: null },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_CONFIG: '' },
			});
			strictEqual((await threadIds(nodeCtx.harper, 'http')).length, 4);
			strictEqual((await threadIds(nodeCtx.harper, 'replication')).length, 0);
		} finally {
			await teardownHarper(nodeCtx).catch(() => {});
		}
	});

	test('falls back to 0 pool workers and replicates on HTTP workers when replication.port shares http.port', async () => {
		let nodes = [];
		try {
			const started = await Promise.allSettled(
				Array.from({ length: NODE_COUNT }, async () => {
					const hostname = await getNextAvailableLoopbackAddress();
					const nodeCtx = { name: `${ctx.name}-shared-http-port`, harper: { hostname } };
					try {
						await startHarper(nodeCtx, {
							config: {
								analytics: { aggregatePeriod: -1 },
								logging: { colors: false, stdStreams: false, console: true, level: 'warn' },
								threads: { count: 4 },
								replication: { port: hostname + ':9926', securePort: null },
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
			nodes = started.filter((result) => result.status === 'fulfilled').map((result) => result.value);
			const failed = started.find((result) => result.status === 'rejected');
			if (failed) throw failed.reason;

			for (const node of nodes) {
				strictEqual((await threadIds(node, 'http')).length, 4);
				strictEqual((await threadIds(node, 'replication')).length, 0);
			}

			for (const node of nodes) {
				await sendOperation(node, {
					operation: 'create_table',
					table: 'fallback_shared',
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'name', type: 'String' },
					],
				});
			}
			await sendOperation(nodes[1], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: nodes[0].hostname,
				retain_authorization: true,
				authorization: nodes[0].admin,
			});
			await waitForCondition((signal) => allConnected(nodes, signal), {
				description: 'the fallback cluster to connect over the shared HTTP port',
			});

			await sendOperation(nodes[0], {
				operation: 'upsert',
				table: 'fallback_shared',
				records: [{ id: '1', name: 'over-shared-http-port' }],
			});
			const record = await waitForCondition((signal) => readReplicated(nodes[1], 'fallback_shared', '1', signal), {
				timeoutMs: 30000,
				description: 'write to replicate over the shared HTTP port on HTTP workers',
			});
			strictEqual(record.name, 'over-shared-http-port');
		} finally {
			await teardownResidencyCluster(nodes);
		}
	});
});
