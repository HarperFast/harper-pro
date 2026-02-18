/**
 * Cluster test
 *
 */
import { suite, test, before, after } from 'node:test';
import { equal, deepEqual } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarper, teardownHarper } from '../../core/integrationTests/utils/harperLifecycle.ts';
import { join } from 'node:path';
import { targz } from '../../core/integrationTests/utils/targz.ts';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);
async function sendOperation(node, operation) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	});
	const responseData = await response.json();
	equal(response.status, 200, JSON.stringify(responseData));
	return responseData;
}

const NODE_COUNT = 3;
suite('Cluster Replication', { timeout: 120000 }, (ctx) => {
	before(async () => {
		// start up the nodes
		ctx.nodes = await Promise.all(
			Array(NODE_COUNT)
				.fill(null)
				.map(async () => {
					const ctx = {};
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
		for (let i = 0; i < NODE_COUNT; i++) {
			for (let j = i + 1; j < NODE_COUNT; j++) {
				await sendOperation(ctx.nodes[i], {
					operation: 'add_node',
					hostname: ctx.nodes[j].hostname,
					authorization: ctx.nodes[j].admin,
				});
			}
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

	test('replicate insert/upsert from node 1', async () => {
		await sendOperation(ctx.nodes[0], {
			operation: 'upsert',
			table: 'test',
			records: [{ id: '1', name: 'test' }],
			replicatedConfirmation: 2,
		});
		console.log('sent upsert to node 1, waiting for replication to node 2 and 3...');
		let response;
		let retries = 0;
		do {
			await sleep(200);
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
			replicatedConfirmation: 2,
		});
		let response = await sendOperation(ctx.nodes[0], {
			operation: 'search_by_id',
			table: 'test',
			get_attributes: ['id', 'name'],
			ids: ['1'],
		});
		equal(response.length, 1);
		equal(response[0].name, 'test2');
		response = await sendOperation(ctx.nodes[2], {
			operation: 'search_by_id',
			table: 'test',
			get_attributes: ['id', 'name'],
			ids: ['1'],
		});
		equal(response.length, 1);
		equal(response[0].name, 'test2');
	});
	test('replicate delete from node 3', async () => {
		await sendOperation(ctx.nodes[2], {
			operation: 'delete',
			table: 'test',
			ids: ['1'],
			replicatedConfirmation: 2,
		});
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
			await sleep(10000);
		});
		test('Replicating cached blobs', async () => {
			let response = await fetchWithRetry(ctx.nodes[0].httpURL + '/Location/2');
			let bodyFrom1 = await response.json();
			console.log(bodyFrom1);
			equal(response.status, 200, JSON.stringify(bodyFrom1));
			equal(bodyFrom1.name, 'location name 2');
			await sleep(500);
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
});

function fetchWithRetry(url, options) {
	console.log('doing fetch to', url);
	let retries = options?.retries ?? 20;
	let response = fetch(url, options);
	if (retries > 0) {
		response = response.catch(() => {
			console.log('fetch failed, retrying...');
			options ??= {};
			options.retries = retries - 1;
			return sleep(500).then(() => fetchWithRetry(url, options));
		});
	}
	return response;
}
