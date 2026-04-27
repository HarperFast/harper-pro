/**
 * Tests fully connected cluster replication (all nodes connected to all nodes).
 * Verifies token-based authentication for node connection, fully connected topology,
 * replication with replicatedConfirmation, LMDB storage engine variant,
 * and blob replication via deployed application.
 */
import { suite, test, before, after } from 'node:test';
import { equal, deepEqual } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, targz, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, fetchWithRetry } from './clusterShared.js';

const NODE_COUNT = 4;
function clusterReplication(ctx) {
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
								stdStreams: false,
								console: true,
							},
							replication: {
								securePort: nodeCtx.harper.hostname + ':9933',
							},
							storage: {
								engine: ctx.testLMDB ? 'lmdb' : 'rocksdb',
							},
						},
						env: {
							HARPER_NO_FLUSH_ON_EXIT: true, // faster teardown
						},
					});
					console.log(
						'finished setting up node: ',
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
			if (retries++ > 20) {
				for (let response of responses) {
					if (response.connections.length !== NODE_COUNT - 1) {
						console.log('Cluster missing a connection', JSON.stringify(response, null, '  '));
					} else if (
						!response.connections.every((connection) => connection.database_sockets.every((socket) => socket.connected))
					) {
						console.log('Cluster has disconnected socket', JSON.stringify(response, null, '  '));
					}
				}
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

	test('replicate insert/upsert from node 1', async () => {
		await sendOperation(ctx.nodes[0], {
			operation: 'upsert',
			table: 'test',
			records: [{ id: '1', name: 'test' }],
			replicatedConfirmation: NODE_COUNT - 1,
		});
		let response;
		let retries = 0;
		do {
			await delay(200);
			response = await sendOperation(ctx.nodes[1], {
				operation: 'search_by_id',
				table: 'test',
				get_attributes: ['id', 'name'],
				ids: ['1'],
			});
			if (retries++ > 10) {
				break;
			}
		} while (response.length === 0);
		if (response.length === 0) {
			throw new Error('Node 1 did not replicate insert');
		}
		equal(response.length, 1);
		equal(response[0].name, 'test');
		response = await sendOperation(ctx.nodes[2], {
			operation: 'search_by_id',
			table: 'test',
			get_attributes: ['id', 'name'],
			ids: ['1'],
		});
		equal(response.length, 1);
		equal(response[0].name, 'test');
	});
	test('replicate update from node 2', async () => {
		await sendOperation(ctx.nodes[1], {
			operation: 'update',
			table: 'test',
			records: [{ id: '1', name: 'test2' }],
			replicatedConfirmation: NODE_COUNT - 1,
		});
		if (ctx.testLMDB) await delay(400); // confirmation isn't working for LMDB
		for (let i = 0; i < NODE_COUNT; i++) {
			let response = await sendOperation(ctx.nodes[i], {
				operation: 'search_by_id',
				table: 'test',
				get_attributes: ['id', 'name'],
				ids: ['1'],
			});
			equal(response.length, 1);
			equal(response[0].name, 'test2');
		}
	});
	test('replicate delete from node 3', async () => {
		await sendOperation(ctx.nodes[2], {
			operation: 'delete',
			table: 'test',
			ids: ['1'],
			replicatedConfirmation: NODE_COUNT - 1,
		});
		if (ctx.testLMDB) await delay(400);
		let response = await sendOperation(ctx.nodes[0], {
			operation: 'search_by_id',
			table: 'test',
			get_attributes: ['id', 'name'],
			ids: ['1'],
		});
		equal(response.length, 0);
		response = await sendOperation(ctx.nodes[1], {
			operation: 'search_by_id',
			table: 'test',
			get_attributes: ['id', 'name'],
			ids: ['1'],
		});
		equal(response.length, 0);
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
			await delay(10000);
		});
		test('Replicating cached blobs', async () => {
			let response = await fetchWithRetry(ctx.nodes[0].httpURL + '/Location/2');
			let bodyFrom1 = await response.json();
			equal(response.status, 200, JSON.stringify(bodyFrom1));
			equal(bodyFrom1.name, 'location name 2');
			await delay(500);
			response = await fetchWithRetry(ctx.nodes[1].httpURL + '/Location/2');
			let bodyFrom2 = await response.json();
			equal(bodyFrom2.name, 'location name 2');
			equal(bodyFrom1.random, bodyFrom2.random);
			response = await fetchWithRetry(ctx.nodes[0].httpURL + '/LocationImage/2');
			equal(response.status, 200);
			const imageFrom1 = await response.bytes();
			response = await fetchWithRetry(ctx.nodes[1].httpURL + '/LocationImage/2');
			const imageFrom2 = await response.bytes();
			deepEqual(imageFrom1, imageFrom2);
		});
	});
}
suite('Cluster Replication', { timeout: 120000 }, clusterReplication);
suite('Cluster Replication with LMDB', { timeout: 120000 }, (ctx) => {
	ctx.testLMDB = true;
	clusterReplication(ctx);
});
