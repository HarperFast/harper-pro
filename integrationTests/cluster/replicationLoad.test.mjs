/**
 * Cluster test
 *
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { targz } from '../../core/integrationTests/utils/targz.ts';
import { sendOperation, fetchWithRetry, concurrent } from './clusterShared.mjs';

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
					const nodeCtx = {
						name: ctx.name,
						harper: {
							hostname: await getNextAvailableLoopbackAddress(),
						},
					};
					await startHarper(nodeCtx, {
						config: {
							analytics: {
								// turn off analytics, it is too noisy and gets in the way
								aggregatePeriod: -1,
							},
							logging: {
								colors: false,
								console: true,
								level: 'debug',
							},
							replication: {
								securePort: nodeCtx.harper.hostname + ':9933',
							},
						},
						env: {
							HARPER_NO_FLUSH_ON_EXIT: true, // faster teardown
						},
					});
					console.log(
						'started node:',
						nodeCtx.harper.dataRootDir.split('/').slice(-2).join(' /'),
						nodeCtx.harper.process.pid,
						nodeCtx.harper.hostname
					);
					return nodeCtx.harper;
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
		if (!ctx.nodes) return;
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
			await delay(200 * retries);
		} while (true);
		await delay(500);
	});
	test('replicate across many databases', async () => {
		const DB_COUNT = 10;
		for (let i = 0; i < DB_COUNT; i++) {
			const db = 'db' + i;
			// create a table on each node
			await Promise.all(
				ctx.nodes.map(async (node) => {
					await sendOperation(node, {
						operation: 'create_table',
						database: db,
						table: 'test',
						primary_key: 'id',
						attributes: [
							{ name: 'id', type: 'ID' },
							{ name: 'name', type: 'String' },
						],
					});
				})
			);
		}
		console.log('created tables');
		await delay(10000);
		for (let i = 0; i < DB_COUNT; i++) {
			const db = 'db' + i;
			for (let j = 0; j < NODE_COUNT; j++) {
				await sendOperation(ctx.nodes[j], {
					operation: 'upsert',
					database: db,
					table: 'test',
					records: [{ id: 'from-node-' + j, name: 'test' }],
				});
			}
		}
		for (let i = 0; i < DB_COUNT; i++) {
			const db = 'db' + i;
			for (let j = 0; j < NODE_COUNT; j++) {
				let retries = 0;
				let response;
				do {
					response = await sendOperation(ctx.nodes[j], {
						operation: 'search_by_value',
						database: db,
						table: 'test',
						search_attribute: 'name',
						search_value: '*',
					});
					if (retries++ > 0) {
						if (retries > 10) {
							ok(false, 'Timed out waiting for replication');
						}
						await delay(retries * 100);
					}
				} while (response.length != NODE_COUNT);
			}
		}
		console.log('done');
	});

	test('replicate insert/upsert across all nodes', async () => {
		const COUNT = 5000;
		let start = performance.now();
		const writtenIds = [];
		let { execute, finish } = concurrent(() => {
			const id = Math.floor(Math.random() * COUNT).toString();
			// we want to stress the structure updates, but do so with uneven distribution
			const additionalPropertyName = 'property-' + Math.floor(Math.pow(Math.random(), 4) * 50);
			const record = { id, name: 'test' + id, [additionalPropertyName]: 'test' };
			writtenIds.push(id);
			return sendOperation(ctx.nodes[Math.floor(Math.random() * NODE_COUNT)], {
				operation: 'upsert',
				table: 'test',
				records: [record],
			});
		});
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
			await delay(retries * 100);
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
		// spot check a few
		for (let nodeI = 0; nodeI < NODE_COUNT; nodeI++) {
			for (let i = 0; i < 10; i++) {
				const record = (
					await sendOperation(ctx.nodes[nodeI], {
						operation: 'search_by_value',
						search_attribute: 'id',
						search_value: writtenIds[i],
						table: 'test',
					})
				)[0];
				equal(record.name, 'test' + writtenIds[i]);
				ok(
					Object.keys(record).length >= 3,
					'should have at least three properties: id, name, and the additional property: ' + JSON.stringify(record)
				);
			}
		}
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
			await delay(35000);
		});
		test('Replicating cached blobs', async () => {
			let start = performance.now();
			let { execute, finish } = concurrent(() => {
				return fetchWithRetry(
					ctx.nodes[Math.floor(Math.random() * NODE_COUNT)].httpURL + '/Location/' + Math.floor(Math.random() * COUNT)
				);
			});
			const COUNT = 5000;
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
