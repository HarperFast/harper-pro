/**
 * Cluster test
 *
 */
import { suite, test, before, after } from 'node:test';
import { equal } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarper, teardownHarper } from '../../core/integrationTests/utils/harperLifecycle.ts';
import { join } from 'node:path';
import { targz } from '../../core/integrationTests/utils/targz.ts';
import { getNextAvailableLoopbackAddress } from '../../core/integrationTests/utils/loopbackAddressPool.ts';
import { sendOperation, fetchWithRetry, concurrent } from './cluster-shared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const NODE_COUNT = 3;
suite('Replication Load Testing', { timeout: 120000 }, (ctx) => {
	before(async () => {
		// start up the nodes
		ctx.nodes = await Promise.all(
			Array(NODE_COUNT)
				.fill(null)
				.map(async () => {
					const ctx = {
						hostname: await getNextAvailableLoopbackAddress(),
					};
					await setupHarper(ctx, {
						config: {
							analytics: {
								// turn off analytics, it is too noisy and gets in the way
								aggregatePeriod: -1,
							},
							logging: {
								colors: false,
								stdStreams: true,
								console: true,
								level: 'warn',
							},
							replication: {
								securePort: ctx.hostname + ':9933',
							},
						},
						env: {
							HARPER_NO_FLUSH_ON_EXIT: true, // faster teardown
						},
					});
					console.log(
						'finished setting up node: ',
						ctx.harper.installDir.split('/').slice(-2).join(' /'),
						ctx.harper.process.pid
					);
					return ctx.harper;
				})
		);
		// create a table on each node
		await Promise.all(
			ctx.nodes.map(async (node) => {
				await sendOperation(node, {
					operation: 'create_table',
					table: 'test',
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'name', type: 'String' },
					],
				});
			})
		);
	});

	after(async () => {
		await Promise.all(
			ctx.nodes.map((node) => {
				return teardownHarper({ harper: node });
			})
		);
		console.log('finished tearing down nodes');
	});

	test('connect nodes', async () => {
		let response = await sendOperation(ctx.nodes[0], {
			operation: 'create_authentication_tokens',
			authorization: ctx.nodes[0].admin,
		});
		let token = response.operation_token;
		for (let j = 1; j < NODE_COUNT; j++) {
			await sendOperation(ctx.nodes[j], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				authorization: 'Bearer ' + token,
			});
		}
		// wait for the cluster to connect
		let retries = 0;
		do {
			let responses = await Promise.all(
				ctx.nodes.map((node) =>
					sendOperation(node, {
						operation: 'cluster_status',
					})
				)
			);
			if (
				responses.every(
					(response) =>
						response.connections.length === NODE_COUNT - 1 &&
						response.connections.every((connection) => connection.database_sockets.every((socket) => socket.connected))
				)
			) {
				// everyone is connected
				break;
			}
			if (retries++ > 10) {
				console.log('Cluster status in timeout', responses);
				responses = await Promise.all(
					ctx.nodes.map((node) =>
						sendOperation(node, {
							operation: 'search_by_value',
							search_attribute: 'name',
							search_value: '*',
							database: 'system',
							table: 'hdb_nodes',
						})
					)
				);
				console.log('hdb_nodes status in timeout', responses);
				throw new Error('Timed out waiting for cluster to connect');
			}
			await sleep(200 * retries);
		} while (true);
		await sleep(500);
	});

	test('replicate insert/upsert across all nodes', async () => {
		const COUNT = 50000;
		let start = performance.now();
		let { execute, finish } = concurrent(() =>
			sendOperation(ctx.nodes[Math.floor(Math.random() * NODE_COUNT)], {
				operation: 'upsert',
				table: 'test',
				records: [{ id: Math.floor(Math.random() * COUNT).toString(), name: 'test' }],
			})
		);
		for (let i = 0; i < COUNT; i++) {
			await execute();
			if (i % 1000 === 0) {
				console.log('sent', i, 'upserts');
			}
		}
		await finish();
		let responses;
		let retries = 0;
		let count;
		do {
			if (retries > 0) {
				console.log('waiting for nodes to sync for ', retries * 100, 'ms');
			}
			await sleep(retries * 100);
			responses = await Promise.all(
				new Array(NODE_COUNT).fill(null).map(async (_, i) => {
					return sendOperation(ctx.nodes[i], {
						operation: 'describe_table',
						table: 'test',
					});
				})
			);
			count = responses[0].record_count;
			if (retries++ > 10) {
				break;
			}
		} while (responses.some((response) => response.record_count !== count));
		console.log(
			'upsert speed',
			((COUNT * 1000) / (performance.now() - start)).toFixed(2),
			'records/sec, total record count',
			count
		);
	});
	suite('Deploy app and test replication', { timeout: 60000 }, () => {
		before(async () => {
			const project = 'test-application';
			const payload = await targz(join(import.meta.dirname, 'fixture'));
			console.log('deploying app');
			const response = await sendOperation(ctx.nodes[0], {
				operation: 'deploy_component',
				project,
				payload,
				replicated: true,
				restart: true,
			});
			console.log('deployed app', response);
			equal(response.message, 'Successfully deployed: test-application, restarting Harper');
			await sleep(10000);
		});
		test('Replicating cached blobs', async () => {
			let start = performance.now();
			let { execute, finish } = concurrent(() => {
				return fetchWithRetry(
					ctx.nodes[Math.floor(Math.random() * NODE_COUNT)].httpURL + '/Location/' + Math.floor(Math.random() * COUNT)
				);
			});
			const COUNT = 50000;
			for (let i = 0; i < COUNT; i++) {
				await execute();
				if (i % 1000 === 0) {
					console.log('sent', i, 'blob requests');
				}
			}
			await finish();
			let response = await sendOperation(ctx.nodes[1], {
				operation: 'describe_table',
				table: 'Location',
			});

			response = await fetchWithRetry(ctx.nodes[1].httpURL + '/Location/2');
			let bodyFrom2 = await response.json();
			equal(bodyFrom2.name, 'location name 2');
			console.log(
				'blob cache retrieval speed',
				((COUNT * 1000) / (performance.now() - start)).toFixed(2),
				'records/sec'
			);
		});
	});
});
