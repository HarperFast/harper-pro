/**
 * Cluster test
 *
 */
import { suite, test, before, after } from 'node:test';
import { equal } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import {
	killHarper,
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { join } from 'node:path';
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
								stdStreams: true,
								console: true,
							},
							replication: {
								securePort: nodeCtx.harper.hostname + ':9933',
								databases: ['data'], // don't replicate system/nodes
							},
						},
						/*env: {
							HARPER_NO_FLUSH_ON_EXIT: true, // faster teardown
						},*/
					});
					console.log(
						'finished setting up node: ',
						nodeCtx.harper.dataRootDir.split('/').slice(-2).join(' /'),
						nodeCtx.harper.process.pid
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
	test('replicate per-record expiration so records evict on receivers', async () => {
		// Create a TTL table — schema replication propagates the table-level
		// expiration to every node so the cleanup scanner is armed everywhere.
		// Records written on node 0 must arrive on every other node carrying
		// their expiresAt metadata so they evict roughly when the sender said
		// they should.
		const TTL_SECONDS = 1;
		await sendOperation(ctx.nodes[0], {
			operation: 'create_table',
			table: 'ttl_test',
			primary_key: 'id',
			expiration: TTL_SECONDS,
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'name', type: 'String' },
			],
		});
		// wait for the table to materialize on every node before we write
		for (let i = 1; i < NODE_COUNT; i++) {
			let retries = 0;
			let described;
			do {
				await delay(100);
				described = await sendOperation(ctx.nodes[i], { operation: 'describe_database' });
			} while (!described?.data?.ttl_test && retries++ < 20);
		}
		// write several records in a single upsert so they share a txn batch on
		// the wire. Past bugs only set the expiresAt metadata for the first
		// record in such a batch, leaving the rest with the receiver's TTL.
		const ttlIds = ['ttl-1', 'ttl-2', 'ttl-3', 'ttl-4'];
		const writtenAt = Date.now();
		await sendOperation(ctx.nodes[0], {
			operation: 'upsert',
			table: 'ttl_test',
			records: ttlIds.map((id) => ({ id, name: 'expires soon' })),
			replicatedConfirmation: NODE_COUNT - 1,
		});
		// the records should be present on every node before TTL elapses
		for (let i = 0; i < NODE_COUNT; i++) {
			let response;
			let retries = 0;
			do {
				await delay(50);
				response = await sendOperation(ctx.nodes[i], {
					operation: 'search_by_id',
					table: 'ttl_test',
					get_attributes: ['id', 'name'],
					ids: ttlIds,
				});
			} while (response.length < ttlIds.length && retries++ < 10);
			equal(
				response.length,
				ttlIds.length,
				`Node ${i} ${ctx.nodes[i].hostname} did not replicate TTL records (got ${response.length})`
			);
		}
		// wait long enough for the sender's expiresAt to pass plus a scan tick.
		// If the receiver's entry metadata is missing expiresAt, records will
		// stick around even after this timeout and the assertion below will fail.
		const elapsed = Date.now() - writtenAt;
		await delay(Math.max(0, TTL_SECONDS * 1000 - elapsed) + 1500);
		for (let i = 0; i < NODE_COUNT; i++) {
			const response = await sendOperation(ctx.nodes[i], {
				operation: 'search_by_id',
				table: 'ttl_test',
				get_attributes: ['id', 'name'],
				ids: ttlIds,
			});
			equal(
				response.length,
				0,
				`Node ${i} ${ctx.nodes[i].hostname} did not evict all replicated records past expiresAt (still has ${response.length})`
			);
		}
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
		// Also create a TTL table on the legacy node and write a record that
		// expires shortly. This exercises the cross-version path where the
		// legacy peer is the producer of the audit-log expiresAt metadata.
		// We create the table on the v5 nodes first (matching attributes and
		// expiration) so they each have a cleanup scanner armed; the v4 peer's
		// schema sync will see no attribute changes and leave the v5 TTL config
		// intact. Without this, the v5 receivers inherit the v4 table without
		// the table-level expiration property (v4 does not transmit it) and
		// nothing reaps the records past expiry.
		const LEGACY_TTL_SECONDS = 2;
		await sendOperation(ctx.nodes[0], {
			operation: 'create_table',
			table: 'legacy_ttl',
			primary_key: 'id',
			expiration: LEGACY_TTL_SECONDS,
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'name', type: 'String' },
			],
		});
		// give the v5 cluster a moment to propagate the new table (and its
		// expiration setting) to the rest of the v5 nodes via schema sync.
		await delay(200);
		await sendOperation(legacyContext.harper, {
			operation: 'create_table',
			table: 'legacy_ttl',
			primary_key: 'id',
			expiration: LEGACY_TTL_SECONDS,
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'name', type: 'String' },
			],
		});
		// write several records in a single upsert so they share a txn batch,
		// exercising the case where only the first record in a batch carried
		// the expiresAt metadata on the receiver.
		const legacyTtlIds = ['legacy-ttl-1', 'legacy-ttl-2', 'legacy-ttl-3', 'legacy-ttl-4'];
		const legacyTtlWrittenAt = Date.now();
		await sendOperation(legacyContext.harper, {
			operation: 'upsert',
			table: 'legacy_ttl',
			records: legacyTtlIds.map((id) => ({ id, name: 'legacy expires soon' })),
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
		// Schema replication carries the legacy_ttl table (including its
		// expiration setting) onto the v5 nodes, which is what arms the cleanup
		// scanner there. Wait for the records to land, then verify they evict
		// at the expiresAt the legacy peer set.
		for (let i = 0; i < NODE_COUNT; i++) {
			retries = 0;
			do {
				response = await sendOperation(ctx.nodes[i], {
					operation: 'search_by_id',
					table: 'legacy_ttl',
					get_attributes: ['id', 'name'],
					ids: legacyTtlIds,
				});
				if (retries++ > 20) break;
				await delay(100);
			} while (response.length < legacyTtlIds.length && Date.now() - legacyTtlWrittenAt < LEGACY_TTL_SECONDS * 1000);
			// it is acceptable for records to have already expired before being
			// observed (test machines can be slow), so we only assert presence if
			// we are still inside the TTL window.
			if (Date.now() - legacyTtlWrittenAt < LEGACY_TTL_SECONDS * 1000) {
				equal(
					response.length,
					legacyTtlIds.length,
					`Node ${i} did not receive all legacy_ttl records before expiry (got ${response.length})`
				);
			}
		}
		const elapsed = Date.now() - legacyTtlWrittenAt;
		await delay(Math.max(0, LEGACY_TTL_SECONDS * 1000 - elapsed) + 2000);
		for (let i = 0; i < NODE_COUNT; i++) {
			response = await sendOperation(ctx.nodes[i], {
				operation: 'search_by_id',
				table: 'legacy_ttl',
				get_attributes: ['id', 'name'],
				ids: legacyTtlIds,
			});
			equal(
				response.length,
				0,
				`Node ${i} ${ctx.nodes[i].hostname} did not evict all legacy-ttl records past expiresAt (still has ${response.length})`
			);
		}
	});
	// The tests below exercise the v4 -> v5 cluster-migration bridge scenario
	// described in the "v4 -> v5 Fabric Cluster Migration Runbook". They build
	// on the legacy node set up by 'Replicate data from a legacy node' above
	// (ctx.nodes[NODE_COUNT]) and run in order: larger-dataset catch-up,
	// bidirectional replication (rollback safety), then bridge teardown last
	// since it removes the legacy peer from the cluster.
	test('Replicate larger v4 dataset across multiple tables', async () => {
		const legacyPath = process.env.HARPER_LEGACY_VERSION_PATH;
		const legacy = ctx.nodes[NODE_COUNT];
		if (!legacyPath || !legacy) return;

		const tables = ['orders', 'users', 'events'];
		const RECORDS_PER_TABLE = 100;
		for (const table of tables) {
			await sendOperation(legacy, {
				operation: 'create_table',
				table,
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'name', type: 'String' },
				],
			});
			const records = [];
			for (let i = 0; i < RECORDS_PER_TABLE; i++) {
				records.push({ id: `${table}-${i}`, name: `${table} record ${i}` });
			}
			await sendOperation(legacy, { operation: 'upsert', table, records });
		}

		// Wait for schema replication to land each table on every v5 node.
		// Without this, the search loop below races schema sync and
		// sendOperation throws on the non-200 (table-not-found) response
		// before its retry can take effect.
		for (const table of tables) {
			for (let i = 0; i < NODE_COUNT; i++) {
				let retries = 0;
				let described;
				do {
					await delay(100);
					described = await sendOperation(ctx.nodes[i], { operation: 'describe_database' });
				} while (!described?.data?.[table] && retries++ < 30);
			}
		}

		// All RECORDS_PER_TABLE rows must arrive on every v5 node for every
		// table. Past audit-forwarding bugs only delivered the first record in
		// a multi-record batch, so we assert full counts (not just presence).
		for (const table of tables) {
			for (let i = 0; i < NODE_COUNT; i++) {
				let response;
				let retries = 0;
				do {
					await delay(200);
					response = await sendOperation(ctx.nodes[i], {
						operation: 'search_by_value',
						search_attribute: 'id',
						search_value: '*',
						table,
						get_attributes: ['id', 'name'],
					});
				} while (response.length < RECORDS_PER_TABLE && retries++ < 30);
				equal(
					response.length,
					RECORDS_PER_TABLE,
					`Node ${i} ${ctx.nodes[i].hostname} only has ${response.length}/${RECORDS_PER_TABLE} records in table ${table}`
				);
			}
		}
	});
	test('Bridge teardown: remove_node disconnects legacy v4 node cleanly', async () => {
		const legacyPath = process.env.HARPER_LEGACY_VERSION_PATH;
		const legacy = ctx.nodes[NODE_COUNT];
		if (!legacyPath || !legacy) return;

		// The legacy node was added to ctx.nodes[0] in 'Replicate data from
		// a legacy node', so remove it from there.
		await sendOperation(ctx.nodes[0], {
			operation: 'remove_node',
			hostname: legacy.hostname,
		});

		// cluster_status on the bridge should no longer list the legacy peer.
		let retries = 0;
		let status;
		do {
			await delay(200);
			status = await sendOperation(ctx.nodes[0], { operation: 'cluster_status' });
		} while (
			status.connections.some((conn) => conn.name === legacy.hostname && conn.database_sockets?.length > 0) &&
			retries++ < 20
		);
		equal(
			status.connections.some((conn) => conn.name === legacy.hostname && conn.database_sockets?.length > 0),
			false,
			'Legacy peer connection still present on bridge after remove_node'
		);

		// v5 mesh must still be intact: a write on one v5 node still
		// propagates to the others. ctx.nodes[2] is a leaf in the star
		// topology, so it only has one peer (the central node) — confirm
		// against that and then poll for transitive arrival at the others.
		await sendOperation(ctx.nodes[2], {
			operation: 'upsert',
			table: 'test',
			records: [{ id: 'post-teardown-1', name: 'written after teardown' }],
			replicatedConfirmation: 1,
		});
		for (let i = 0; i < NODE_COUNT; i++) {
			let response;
			retries = 0;
			do {
				await delay(200);
				response = await sendOperation(ctx.nodes[i], {
					operation: 'search_by_id',
					table: 'test',
					get_attributes: ['id', 'name'],
					ids: ['post-teardown-1'],
				});
			} while (response.length === 0 && retries++ < 20);
			equal(
				response.length,
				1,
				`v5 mesh broken after bridge teardown: node ${i} ${ctx.nodes[i].hostname} did not receive post-teardown write`
			);
		}
	});
});
