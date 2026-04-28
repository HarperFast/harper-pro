import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

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

async function waitForAvailableStatus(node, timeoutMs = 60000, checkInterval = 2000) {
	const timeoutAt = Date.now() + timeoutMs;

	while (Date.now() < timeoutAt) {
		console.log('Waiting for cloned node status to become Available...');
		await sleep(checkInterval);
		let response;
		try {
			response = await sendOperation(node, { operation: 'get_status', id: 'availability' });
		} catch {}
		if (response?.status === 'Available') return true;
	}

	throw new Error(`Node status did not become Available within ${timeoutMs}ms`);
}

suite('Clone Node', (ctx) => {
	before(async () => {
		ctx.nodes = [];
		const nodeCtx = {
			name: ctx.name,
			harper: {
				hostname: await getNextAvailableLoopbackAddress(),
			},
		};
		await startHarper(nodeCtx, {
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false },
				replication: {
					port: nodeCtx.harper.hostname + ':9933',
					securePort: null,
				},
			},
			// set some random custom env var to verify it gets copied to the clone
			env: {
				HARPER_NO_FLUSH_ON_EXIT: true,
				LOGGING_LEVEL: 'debug',
				LOGGING_ROTATION_MAXSIZE: '101M',
				MQTT_NETWORK_PORT: 1212,
			},
		});
		ctx.nodes.push(nodeCtx.harper);

		// Create a table and insert some data to verify that it gets cloned properly
		await sendOperation(nodeCtx.harper, {
			operation: 'create_table',
			table: 'test',
			primary_key: 'id',
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'name', type: 'String' },
			],
		});

		await sendOperation(nodeCtx.harper, {
			operation: 'upsert',
			table: 'test',
			records: [{ id: '1', name: 'test-clone' }],
		});

		// Create authentication tokens to verify that they get cloned properly
		await sendOperation(nodeCtx.harper, {
			operation: 'create_authentication_tokens',
			username: nodeCtx.harper.admin.username,
			password: nodeCtx.harper.admin.password,
		});

		// Add an SSH key to verify that it gets cloned properly
		await sendOperation(nodeCtx.harper, {
			operation: 'add_ssh_key',
			name: 'clonetestkey1',
			key: 'clonerandom\nstring',
			host: 'testkey1.gitlab.com',
			hostname: 'gitlab.com',
			known_hosts: 'gitlab.com fake1\ngitlab.com fake2',
		});
	});

	after(async () => {
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('should clone a node successfully', async () => {
		const createTokenResponse = await sendOperation(ctx.nodes[0], {
			operation: 'create_authentication_tokens',
			authorization: ctx.nodes[0].admin,
			expires_in: '5Minutes',
		});

		const cloneCtx = {
			name: ctx.name,
			harper: {
				hostname: await getNextAvailableLoopbackAddress(),
			},
		};
		await startHarper(cloneCtx, {
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false },
				replication: {
					port: cloneCtx.harper.hostname + ':9933',
					securePort: null,
				},
			},
			env: {
				HDB_LEADER_URL: `http://${ctx.nodes[0].hostname}:9925`,
				HDB_LEADER_TOKEN: createTokenResponse.operation_token,
				ALLOW_SELF_SIGNED: true,
				HARPER_NO_FLUSH_ON_EXIT: true,
			},
		});
		ctx.nodes.push(cloneCtx.harper);

		await waitForAvailableStatus(ctx.nodes[1]);

		// Verify that configuration was cloned successfully by checking the operations API of the clone node
		const responseClone = await sendOperation(ctx.nodes[1], {
			operation: 'get_configuration',
		});
		equal(responseClone.logging?.level, 'debug', 'Logging level should be cloned');
		equal(responseClone.logging?.rotation?.maxSize, '101M', 'Logging rotation maxSize should be cloned');
		equal(responseClone.mqtt?.network?.port, 1212, 'MQTT network port should be cloned');
		equal(responseClone.cloned, true, 'Node should be marked as cloned');

		// Verify that cluster status shows both nodes connected to each other
		const clusterStatusNode1 = await sendOperation(ctx.nodes[0], {
			operation: 'cluster_status',
		});
		equal(clusterStatusNode1.connections.length, 1, 'Leader node should have 1 connection');
		equal(clusterStatusNode1.connections?.[0]?.database_sockets.length, 2, 'Leader node should be connected to clone');

		const clusterStatusNode2 = await sendOperation(ctx.nodes[1], {
			operation: 'cluster_status',
		});
		equal(clusterStatusNode2.connections.length, 1, 'Clone node should have 1 connection');
		equal(clusterStatusNode2.connections?.[0]?.database_sockets.length, 2, 'Clone node should be connected to leader');

		// Verify that data was cloned successfully by querying the clone node for data that was inserted into the leader node before cloning
		const responseData = await sendOperation(ctx.nodes[1], {
			operation: 'search_by_id',
			table: 'test',
			get_attributes: ['id', 'name'],
			ids: ['1'],
		});
		equal(responseData.length, 1, 'Should find 1 record in clone node');
		equal(responseData[0].name, 'test-clone', 'Record name should match the original');

		const sshKeys = await sendOperation(ctx.nodes[1], {
			operation: 'list_ssh_keys',
		});
		equal(sshKeys.length, 1, 'Should find 1 SSH key in clone node');
		equal(sshKeys[0].name, 'clonetestkey1', 'SSH key name should match the original');

		// Verify that JWT keys were cloned successfully
		const jwtKeyNames = ['.jwtPublic', '.jwtPrivate', '.jwtPass'];
		for (const keyName of jwtKeyNames) {
			const leaderKeyResponse = await sendOperation(ctx.nodes[0], {
				operation: 'get_key',
				name: keyName,
			});
			const cloneKeyResponse = await sendOperation(ctx.nodes[1], {
				operation: 'get_key',
				name: keyName,
			});
			equal(
				cloneKeyResponse.message,
				leaderKeyResponse.message,
				`JWT key ${keyName} should match between leader and clone`
			);
		}
	});

	test('should clone three more nodes successfully', async () => {
		const TOTAL_NEW_NODES = 3;

		for (let i = 0; i < TOTAL_NEW_NODES; i++) {
			const cloneCtx = {
				name: ctx.name,
				harper: {
					hostname: await getNextAvailableLoopbackAddress(),
				},
			};
			await startHarper(cloneCtx, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false },
					replication: {
						port: cloneCtx.harper.hostname + ':9933',
						securePort: null,
					},
				},
				env: {
					HDB_LEADER_URL: `http://${ctx.nodes[0].hostname}:9925`,
					HDB_LEADER_USERNAME: ctx.nodes[0].admin.username,
					HDB_LEADER_PASSWORD: ctx.nodes[0].admin.password,
					ALLOW_SELF_SIGNED: true,
					HARPER_NO_FLUSH_ON_EXIT: true,
				},
			});
			ctx.nodes.push(cloneCtx.harper);

			const newNodeIndex = ctx.nodes.length - 1;

			await waitForAvailableStatus(ctx.nodes[newNodeIndex]);
		}

		for (let j = 0; j < ctx.nodes.length; j++) {
			const node = ctx.nodes[j];
			const clusterStatus = await sendOperation(node, {
				operation: 'cluster_status',
			});

			equal(clusterStatus.connections.length, 4, JSON.stringify(clusterStatus));
			for (let connection of clusterStatus.connections) {
				equal(connection.database_sockets.length, 2, JSON.stringify(connection));
				for (let socket of connection.database_sockets) {
					ok(socket.connected, 'connected');
				}
			}
		}
		console.log('done');
	});
});
