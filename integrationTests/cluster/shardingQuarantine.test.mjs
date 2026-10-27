import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { basename, join } from 'node:path';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	postOperation,
	sendOperation,
	stopAndTeardownNodes,
	stopNodeProcess,
	waitForCondition,
} from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const fixture = join(import.meta.dirname, 'fixture-sharding-quarantine');
const shardedSchema = `type ShardedRows @table @export @sharded(by: "tenant", slotFrom: "0") {
	id: ID @primaryKey
	tenant: String @indexed
	body: String
}`;
const healthySchema = `type HealthyRows @table(database: "healthy") @export {
	id: ID @primaryKey
	body: String
}`;

async function request(node, path, signal, body) {
	const response = await fetch(`${node.httpURL}/${path}`, {
		method: body === undefined ? 'GET' : 'PUT',
		signal,
		headers: {
			'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
			'Content-Type': 'application/json',
			'Connection': 'close',
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: response.status, thread: response.headers.get('x-sharding-thread'), body: await response.text() };
}

async function assertQuarantineSQL(node) {
	const response = await postOperation(node, {
		operation: 'sql',
		sql: "SELECT IIF(tenant = 'a', body, 'other') FROM data.ShardedRows",
	});
	assert.equal(response.status, 503, JSON.stringify(response.body));
	assert.match(JSON.stringify(response.body), /repair the configuration and restart this node/);
}

for (const healthyFirst of [false, true]) {
	suite(`Sharding database quarantine (healthy first=${healthyFirst})`, { timeout: 600_000 }, (ctx) => {
		const contexts = [{ name: ctx.name }, { name: ctx.name }];
		const nodes = () => contexts.map((context) => context.harper);
		const start = (context, threads, shards) =>
			startHarper(context, {
				config: {
					threads: { count: threads },
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, level: 'warn' },
					replication: { securePort: context.harper.hostname + ':9933', databases: '*', ...(shards ? { shards } : {}) },
					operationsApi: { network: { domainSocket: false } },
				},
			});
		async function workers(node, old = new Set()) {
			const seen = new Set();
			await waitForCondition(
				async (signal) => {
					const responses = await Promise.all(
						Array.from({ length: 8 }, () => request(node, 'ShardingWorker/', signal))
					);
					for (const response of responses) {
						if (response.status === 200 && !old.has(response.thread)) seen.add(response.thread);
					}
					return seen.size === 4;
				},
				{ description: 'all four HTTP workers are serving', timeoutMs: 120_000 }
			);
			return seen;
		}
		async function assertEveryWorker(node, path, expected, serving, transition = false) {
			const seen = new Set();
			await waitForCondition(
				async (signal) => {
					const responses = await Promise.all(Array.from({ length: 8 }, () => request(node, path, signal)));
					if (transition && responses.some((response) => response.status !== expected)) {
						seen.clear();
						return false;
					}
					for (const response of responses) {
						assert.equal(response.status, expected, JSON.stringify(response));
						assert.ok(serving.has(response.thread), JSON.stringify(response));
						seen.add(response.thread);
					}
					return seen.size === serving.size;
				},
				{ description: `${path} returns ${expected} on every worker`, timeoutMs: 30_000 }
			);
		}
		async function replace(node, old) {
			const response = await sendOperation(node, { operation: 'restart_service', service: 'http_workers' });
			assert.ok(response.job_id);
			await waitForCondition(
				async (signal) => {
					const [job] = await sendOperation(node, { operation: 'get_job', id: response.job_id }, { signal });
					assert.notEqual(job?.status, 'ERROR', JSON.stringify(job));
					return job?.status === 'COMPLETE';
				},
				{ description: 'HTTP worker replacement finishes', timeoutMs: 120_000 }
			);
			return workers(node, old);
		}
		before(async () => {
			for (let i = 0; i < contexts.length; i++) {
				const context = contexts[i];
				context.harper = {
					hostname: await getNextAvailableLoopbackAddress(),
					dataRootDir: await mkdtemp(
						join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'sharding-quarantine-')
					),
				};
				await start(context, i ? 1 : 4);
				await sendOperation(context.harper, {
					operation: 'set_configuration',
					replication_shard: i,
					replication_shards: [0, 1],
				});
				await stopNodeProcess(context.harper);
				const destination = join(context.harper.dataRootDir, 'components', basename(fixture));
				await cp(fixture, destination, { recursive: true });
				await writeFile(
					join(destination, 'schema.graphql'),
					(healthyFirst ? [healthySchema, shardedSchema] : [shardedSchema, healthySchema]).join('\n')
				);
				await start(context, i ? 1 : 4);
			}
			const [a, b] = nodes();
			const { operation_token: token } = await sendOperation(a, {
				operation: 'create_authentication_tokens',
				authorization: a.admin,
			});
			await sendOperation(b, {
				operation: 'add_node',
				hostname: a.hostname,
				authorization: 'Bearer ' + token,
				rejectUnauthorized: false,
			});
			await waitForCondition(
				async (signal) => {
					const status = await sendOperation(a, { operation: 'cluster_status' }, { signal });
					return (
						status.sharding?.data?.recovery?.phase === 'ready' &&
						status.connections.some((connection) =>
							connection.database_sockets.some((socket) => socket.database === 'data' && socket.connected)
						)
					);
				},
				{ description: 'sharded peer connected' }
			);
			for (const [path, body] of [
				['HealthyRows/healthy', { id: 'healthy', body: 'healthy' }],
				['ShardedRows/sharded', { id: 'sharded', tenant: 'tenant', body: 'kept' }],
			]) {
				const response = await request(a, path, AbortSignal.timeout(30_000), body);
				assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response));
			}
		});
		after(() => stopAndTeardownNodes(nodes()));

		test('live refusal stays within its database and repair reaches every replacement worker', async () => {
			const [node, peer] = nodes();
			const original = await workers(node);
			await sendOperation(node, { operation: 'set_configuration', replication_shards: [1] });
			const invalid = await replace(node, original);
			await assertEveryWorker(node, 'HealthyRows/healthy', 200, invalid);
			await assertEveryWorker(node, 'ShardedRows/sharded', 503, invalid);
			const refused = await postOperation(
				node,
				{
					operation: 'insert',
					database: 'data',
					table: 'ShardedRows',
					records: [{ id: 'held-operation', tenant: 'tenant', body: 'must not commit' }],
				},
				{ signal: AbortSignal.timeout(10_000) }
			);
			assert.equal(refused.status, 503, JSON.stringify(refused.body));
			await waitForCondition(
				async (signal) => {
					const status = await sendOperation(peer, { operation: 'cluster_status' }, { signal });
					return status.sharding?.data?.errors?.some((error) => error.includes('replication.shards differs'));
				},
				{ description: 'connected peer observes the invalid shard-list digest', timeoutMs: 30_000 }
			);
			await sendOperation(node, { operation: 'set_configuration', replication_shards: [0, 1] });
			await assertEveryWorker(node, 'ShardedRows/sharded', 200, invalid, true);
			await sendOperation(
				node,
				{
					operation: 'insert',
					database: 'data',
					table: 'ShardedRows',
					records: [{ id: 'repaired-operation', tenant: 'tenant', body: 'committed after repair' }],
				},
				{ signal: AbortSignal.timeout(10_000) }
			);
			await waitForCondition(
				async (signal) => {
					const status = await sendOperation(peer, { operation: 'cluster_status' }, { signal });
					return (
						status.sharding?.data &&
						!status.sharding.data.errors?.some((error) => error.includes('replication.shards differs'))
					);
				},
				{ description: 'connected peer observes the repaired shard-list digest', timeoutMs: 30_000 }
			);
			await sendOperation(node, { operation: 'set_configuration', replication_shards: [1] });
			await assertEveryWorker(node, 'ShardedRows/sharded', 503, invalid, true);
			await assertEveryWorker(node, 'HealthyRows/healthy', 200, invalid);
			await stopNodeProcess(peer);
			await waitForCondition(
				async (signal) => {
					const status = await sendOperation(node, { operation: 'cluster_status' }, { signal });
					return !status.connections.some((connection) =>
						connection.database_sockets.some((socket) => socket.connected)
					);
				},
				{ description: 'peer is disconnected before local repair', timeoutMs: 90_000 }
			);
			await sendOperation(node, { operation: 'set_configuration', replication_shards: [0, 1] });
			await assertEveryWorker(node, 'HealthyRows/healthy', 200, invalid);
			await assertEveryWorker(node, 'ShardedRows/sharded', 200, invalid, true);
			const repaired = await replace(node, invalid);
			await assertEveryWorker(node, 'HealthyRows/healthy', 200, repaired);
			await assertEveryWorker(node, 'ShardedRows/sharded', 200, repaired);
			await start(contexts[1], 1);
		});

		test('startup quarantine survives config repair and worker replacement until full restart', async () => {
			const [node] = nodes();
			await sendOperation(node, { operation: 'set_configuration', replication_shards: [1] });
			await stopNodeProcess(node);
			await start(contexts[0], 4, [1]);
			const quarantined = await workers(node);
			await assertEveryWorker(node, 'HealthyRows/healthy', 200, quarantined);
			await assertEveryWorker(node, 'ShardedRows/sharded', 503, quarantined);
			await assertQuarantineSQL(node);
			await sendOperation(node, { operation: 'set_configuration', replication_shards: [0, 1] });
			const replacement = await replace(node, quarantined);
			await assertEveryWorker(node, 'HealthyRows/healthy', 200, replacement);
			await assertEveryWorker(node, 'ShardedRows/sharded', 503, replacement);
			await assertQuarantineSQL(node);
			await stopNodeProcess(node);
			await start(contexts[0], 4, [0, 1]);
			const restarted = await workers(node);
			await assertEveryWorker(node, 'HealthyRows/healthy', 200, restarted);
			await assertEveryWorker(node, 'ShardedRows/sharded', 200, restarted);
		});
	});
}
