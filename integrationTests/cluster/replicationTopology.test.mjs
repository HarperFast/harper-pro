/**
 * Cluster test
 *
 */
import { suite, test, before, after } from 'node:test';
import { equal } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { killHarper, startHarper, teardownHarper } from '../../core/integrationTests/utils/harperLifecycle.ts';
import { join } from 'node:path';
import { getNextAvailableLoopbackAddress } from '../../core/integrationTests/utils/loopbackAddressPool.ts';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const NODE_COUNT = 4;
suite('Replication Topology', { timeout: 120000 }, (ctx) => {
	before(async () => {
		// start up the nodes
		ctx.nodes = await Promise.all(
			Array(NODE_COUNT)
				.fill(null)
				.map(async () => {
					const ctx = {
						harper: {
							hostname: await getNextAvailableLoopbackAddress(),
						},
					};
					await startHarper(ctx, {
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
							replication: {
								securePort: ctx.harper.hostname + ':9933',
								databases: ['data'], // don't replicate system/nodes
							},
						},
						/*env: {
							HARPER_NO_FLUSH_ON_EXIT: true, // faster teardown
						},*/
					});
					console.log(
						'finished setting up node: ',
						ctx.harper.dataRootDir.split('/').slice(-2).join(' /'),
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
		for (let j = 1; j < NODE_COUNT; j++) {
			await sendOperation(ctx.nodes[j], {
				// without replicating the nodes, this should result in a star-topology
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				authorization: ctx.nodes[j].admin,
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
					(response, i) =>
						response.connections.length === (i === 0 ? NODE_COUNT - 1 : 1) && // veryify the star topology
						response.connections.every(
							(connection) =>
								connection.database_sockets.length === 1 &&
								connection.database_sockets.every((socket) => socket.connected)
						)
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
			replicatedConfirmation: 1,
		});
		// we don't really have anyway of know when the message transitively replicated to the next node, so just wait
		await delay(200);
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
			replicatedConfirmation: 1,
		});
		let response = await sendOperation(ctx.nodes[0], {
			operation: 'search_by_id',
			table: 'test',
			get_attributes: ['id', 'name'],
			ids: ['1'],
		});
		equal(response.length, 0);
		// we don't really have anyway of know when the message transitively replicated to the next node, so just wait
		await delay(200);
		response = await sendOperation(ctx.nodes[1], {
			operation: 'search_by_id',
			table: 'test',
			get_attributes: ['id', 'name'],
			ids: ['1'],
		});
		equal(response.length, 0);
	});
	test('take down the central node, do writes and verify catchup afterwards', async () => {
		await killHarper({ harper: ctx.nodes[0] });
		await sendOperation(ctx.nodes[1], {
			operation: 'upsert',
			table: 'test',
			records: [{ id: '2', name: 'test while disconnected' }],
		});
		let response;
		ctx.nodes[0] = (await startHarper({ harper: ctx.nodes[0] })).harper;
		let retries = 0;
		// ensure the data gets to the central node
		do {
			await delay(200);
			response = await sendOperation(ctx.nodes[0], {
				operation: 'search_by_id',
				table: 'test',
				get_attributes: ['id', 'name'],
				ids: ['2'],
			});
			if (retries++ > 10) {
				break;
			}
		} while (response.length === 0);
		if (response.length === 0) {
			throw new Error('Node 1 did not replicate insert');
		}
		// and the data is passed on to the other node
		equal(response.length, 1);
		equal(response[0].name, 'test while disconnected');
		do {
			await delay(200);
			response = await sendOperation(ctx.nodes[2], {
				operation: 'search_by_id',
				table: 'test',
				get_attributes: ['id', 'name'],
				ids: ['2'],
			});
			if (retries++ > 10) {
				break;
			}
		} while (response.length === 0);
		equal(response.length, 1);
		equal(response[0].name, 'test while disconnected');
	});
	test('Replicate data from a legacy node', async () => {
		const legacyPath = process.env.HARPER_LEGACY_VERSION_PATH;
		if (!legacyPath) return;
		const hostname = await getNextAvailableLoopbackAddress();
		const legacyContext = {
			harper: {
				hostname,
			},
		};
		await startHarper(legacyContext, {
			config: {
				logging: {
					colors: false,
					stdStreams: true,
					console: true,
				},
				replication: {
					securePort: hostname + ':9933',
					databases: ['data'], // don't replicate system/nodes
				},
			},
			env: {
				TC_AGREEMENT: 'yes',
				REPLICATION_HOSTNAME: hostname,
			},
			harperBinPath: join(legacyPath, 'bin', 'harperdb.js'),
		});
		ctx.nodes.push(legacyContext.harper); // make it gets cleaned up
		// load data:
		await sendOperation(legacyContext.harper, {
			operation: 'create_table',
			table: 'test',
			primary_key: 'id',
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'name', type: 'String' },
			],
		});
		await sendOperation(legacyContext.harper, {
			operation: 'upsert',
			table: 'test',
			records: [{ id: 'old-data-1', name: 'old data test' }],
		});
		await sendOperation(ctx.nodes[0], {
			// connect the central node
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname,
			authorization: ctx.nodes[0].admin,
		});
		let retries = 0;
		let response;
		do {
			response = await sendOperation(ctx.nodes[0], {
				operation: 'cluster_status',
			});
			if (retries++ > 10) {
				break;
			}
			await delay(200 * retries);
		} while (
			!response.connections.some((connection) => connection.name === hostname && connection.database_sockets.length > 0)
		);
		for (let i = 0; i < NODE_COUNT; i++) {
			do {
				response = await sendOperation(ctx.nodes[i], {
					operation: 'search_by_id',
					table: 'test',
					get_attributes: ['id', 'name'],
					ids: ['old-data-1'],
				});
				if (retries++ > 10) {
					break;
				}
				await delay(200 * retries);
			} while (response.length === 0);
			equal(response.length, 1, `Node ${i} ${ctx.nodes[i].hostname} did not replicate data from legacy node`);
			equal(response[0].name, 'old data test');
		}
	});
});
