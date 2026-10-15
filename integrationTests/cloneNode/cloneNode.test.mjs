import { suite, test, before, after } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert';
import {
	startHarper,
	teardownHarper,
	killHarper,
	getNextAvailableLoopbackAddress,
	targz,
} from '@harperfast/integration-testing';
import { generateKeyPairSync } from 'node:crypto';
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readLog } from '../cluster/clusterShared.mjs';

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

async function waitForAvailableStatus(node, timeoutMs = 120000, checkInterval = 2000) {
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

// Applications whose dependencies exist only in node_modules, in the two shapes harper-pro#1047 hit:
// a `file:` dependency into node_modules, and a monorepo workspace package a Next.js standalone build
// copies into node_modules without listing it. npm can reinstall neither. Built at run time because the
// repository ignores node_modules. The `file:` package is imported rather than loaded as a component: a
// nested component's loader link to the Harper install would make the leader package the whole install.
const NODE_MODULES_ONLY_APPLICATIONS = {
	'vendored-loader-app': {
		endpoint: 'VendoredLoader',
		expected: { loadedFrom: 'vendored-loader' },
		files: {
			'package.json': JSON.stringify({
				name: 'vendored-loader-app',
				version: '1.0.0',
				type: 'module',
				dependencies: { 'vendored-loader': 'file:./node_modules/vendored-loader' },
			}),
			'config.yaml': 'rest: true\njsResource:\n  files: resources.js\n',
			'resources.js':
				"import { loadedFrom } from 'vendored-loader';\n\nexport class VendoredLoader extends Resource {\n\tget() {\n\t\treturn { loadedFrom };\n\t}\n}\n",
			'node_modules/vendored-loader/package.json': JSON.stringify({
				name: 'vendored-loader',
				version: '1.0.0',
				type: 'module',
				exports: './index.js',
			}),
			'node_modules/vendored-loader/index.js': "export const loadedFrom = 'vendored-loader';\n",
		},
	},
	'standalone-build-app': {
		endpoint: 'StandaloneBuild',
		expected: { label: 'workspace-package' },
		files: {
			'package.json': JSON.stringify({ name: 'standalone-build-app', version: '1.0.0', type: 'module' }),
			'config.yaml': 'rest: true\njsResource:\n  files: resources.js\n',
			'resources.js':
				"import { label } from '@repo/logger';\n\nexport class StandaloneBuild extends Resource {\n\tget() {\n\t\treturn { label };\n\t}\n}\n",
			'node_modules/@repo/logger/package.json': JSON.stringify({
				name: '@repo/logger',
				version: '0.0.0',
				private: true,
				type: 'module',
				exports: './index.js',
			}),
			'node_modules/@repo/logger/index.js': "export const label = 'workspace-package';\n",
		},
	},
};

async function deployNodeModulesOnlyApplications(node) {
	const scratch = mkdtempSync(join(tmpdir(), 'clone-node-modules-only-'));
	try {
		for (const [project, { files }] of Object.entries(NODE_MODULES_ONLY_APPLICATIONS)) {
			const appDir = join(scratch, project);
			for (const [file, content] of Object.entries(files)) {
				mkdirSync(dirname(join(appDir, file)), { recursive: true });
				writeFileSync(join(appDir, file), content);
			}
			await sendOperation(node, {
				operation: 'deploy_component',
				project,
				payload: await targz(appDir),
				restart: true,
			});
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

async function assertNodeModulesOnlyApplicationsServe(node, timeoutMs = 60000) {
	for (const [project, { endpoint, expected }] of Object.entries(NODE_MODULES_ONLY_APPLICATIONS)) {
		const deadline = Date.now() + timeoutMs;
		let status;
		let body;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(`${node.httpURL}/${endpoint}`, { headers: { Accept: 'application/json' } });
				status = response.status;
				body = await response.text();
				if (status === 200) break;
			} catch (error) {
				body = String(error);
			}
			await sleep(1000);
		}
		equal(status, 200, `${project} must serve /${endpoint} on ${node.hostname}: ${body}`);
		deepEqual(JSON.parse(body), expected, `${project} must answer from its node_modules-only package`);
	}
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
			key: generateKeyPairSync('ec', {
				namedCurve: 'P-256',
				publicKeyEncoding: { type: 'spki', format: 'pem' },
				privateKeyEncoding: { type: 'sec1', format: 'pem' },
			}).privateKey,
			host: 'testkey1.gitlab.com',
			hostname: 'gitlab.com',
			known_hosts: 'gitlab.com fake1\ngitlab.com fake2',
		});
		// ...beside a key stored before add_ssh_key validated keys, which the clone must skip without
		// losing the valid one; named to list first where readdir is ordered (APFS, not ext4)
		const leaderSSHDir = join(nodeCtx.harper.dataRootDir, 'ssh');
		const legacyKeyFile = join(leaderSSHDir, 'aaalegacykey.key');
		writeFileSync(legacyKeyFile, 'not\na key', { mode: 0o600 });
		appendFileSync(
			join(leaderSSHDir, 'config'),
			`\n#aaalegacykey\nHost legacy.gitlab.com\n\tHostName gitlab.com\n\tUser git\n\tIdentityFile ${legacyKeyFile}\n\tIdentitiesOnly yes`
		);

		// Deploy a filesystem-only application file-by-file using set_component_file.
		// This creates the component on disk without a config entry and without triggering
		// loadComponent validation, which exercises the new cloneApplications() path in cloneNode.
		const fixtureDir = join(import.meta.dirname, 'fixture', 'test-app');
		for (const file of ['config.yaml', 'resources.js', 'schema.graphql']) {
			await sendOperation(nodeCtx.harper, {
				operation: 'set_component_file',
				project: 'filesystem-app',
				file,
				payload: readFileSync(join(fixtureDir, file), 'utf8'),
			});
		}

		// Deploy a config-referenced application via payload so it gets a config entry.
		// cloneApplications() should skip this — it will be reinstalled via config on the clone.
		await sendOperation(nodeCtx.harper, {
			operation: 'deploy_component',
			project: 'config-app',
			package: 'HarperFast/application-template',
		});

		await deployNodeModulesOnlyApplications(nodeCtx.harper);
		await assertNodeModulesOnlyApplicationsServe(nodeCtx.harper);
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
		let completedAttempt;
		for (let i = 0; i < 60 && typeof completedAttempt?.completedAt !== 'number'; i++) {
			await sleep(500);
			try {
				completedAttempt = JSON.parse(readFileSync(join(ctx.nodes[1].dataRootDir, '.cloneAttempt.json'), 'utf8'));
			} catch {}
		}
		equal(
			typeof completedAttempt?.completedAt,
			'number',
			'The completed clone attempt should carry its grace timestamp'
		);

		// Verify that configuration was cloned successfully by checking the operations API of the clone node
		const responseClone = await sendOperation(ctx.nodes[1], {
			operation: 'get_configuration',
		});
		equal(responseClone.logging?.level, 'debug', 'Logging level should be cloned');
		equal(responseClone.logging?.rotation?.maxSize, '101M', 'Logging rotation maxSize should be cloned');
		equal(responseClone.cloned, true, 'Node should be marked as cloned');

		// Verify clone-temp-admin was cleaned up after token-auth clone
		const cloneUsers = await sendOperation(ctx.nodes[1], { operation: 'list_users' });
		ok(!cloneUsers.some((u) => u.username === 'clone-temp-admin'), 'clone-temp-admin should not exist on cloned node');

		// Regression guard: a previous version of the cleanup called
		// `databases.system.hdb_user.delete({ username: 'clone-temp-admin' })`. Because the argument
		// is an object without `.id`, Resource.transactional treated it as a collection delete and
		// ran an unfiltered full-table scan, wiping every row in hdb_user on the cloning node. The
		// resulting tombstones then replicated cluster-wide and emptied the leader's user table too,
		// breaking authentication for every subsequent clone attempt. Assert that the real admin
		// user survived on both the clone and the leader.
		ok(
			cloneUsers.some((u) => u.username === ctx.nodes[0].admin.username),
			`Leader's admin user (${ctx.nodes[0].admin.username}) should be replicated and present on the cloned node`
		);
		const leaderUsers = await sendOperation(ctx.nodes[0], { operation: 'list_users' });
		ok(leaderUsers.length > 0, 'Leader hdb_user must not be emptied by clone cleanup');
		ok(
			leaderUsers.some((u) => u.username === ctx.nodes[0].admin.username),
			`Leader's admin user (${ctx.nodes[0].admin.username}) should still exist on the leader after clone cleanup`
		);

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

		// Verify that data was cloned successfully by querying the clone node for data that was inserted into the leader node before cloning.
		// "Available" status doesn't guarantee all data has finished copying, so retry until the record appears.
		let responseData;
		for (let retries = 0; ; retries++) {
			try {
				responseData = await sendOperation(ctx.nodes[1], {
					operation: 'search_by_id',
					table: 'test',
					get_attributes: ['id', 'name'],
					ids: ['1'],
				});
				if (responseData.length === 1) break;
			} catch {}
			if (retries >= 20) {
				equal(responseData?.length ?? 0, 1, 'Should find 1 record in clone node');
				break;
			}
			await sleep(500);
		}
		equal(responseData[0].name, 'test-clone', 'Record name should match the original');

		const sshKeys = await sendOperation(ctx.nodes[1], {
			operation: 'list_ssh_keys',
		});
		equal(sshKeys.length, 1, 'Should find only the valid SSH key in clone node');
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

		// Verify both applications were cloned to the clone node
		const cloneApps = await sendOperation(ctx.nodes[1], { operation: 'get_components' });
		const appEntries = cloneApps.entries ?? [];

		const filesystemApp = appEntries.find((e) => e.name === 'filesystem-app');
		const configApp = appEntries.find((e) => e.name === 'config-app');

		ok(filesystemApp, 'filesystem-only application should be cloned to the clone node');
		ok(configApp, 'config-referenced application should be cloned to the clone node');
		ok(!filesystemApp?.package, 'filesystem-only application should not have a config package reference on the clone');
		ok(configApp?.package, 'config-referenced application should retain its package reference on the clone');

		await assertNodeModulesOnlyApplicationsServe(ctx.nodes[1]);
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

		// wait for the full mesh to establish — reaching Available status does not guarantee
		// that all cross-node replication sockets have connected yet
		let retries = 0;
		let statuses;
		while (true) {
			statuses = await Promise.all(ctx.nodes.map((node) => sendOperation(node, { operation: 'cluster_status' })));
			const fullyConnected = statuses.every(
				(status) =>
					status.connections.length === ctx.nodes.length - 1 &&
					status.connections.every(
						(connection) =>
							connection.database_sockets.length === 2 &&
							connection.database_sockets.every((socket) => socket.connected)
					)
			);
			if (fullyConnected) break;
			if (retries++ > 20) {
				throw new Error(`Cluster did not fully connect: ${JSON.stringify(statuses)}`);
			}
			await sleep(500 * retries);
		}

		for (const clusterStatus of statuses) {
			equal(clusterStatus.connections.length, ctx.nodes.length - 1, JSON.stringify(clusterStatus));
			for (const connection of clusterStatus.connections) {
				equal(connection.database_sockets.length, 2, JSON.stringify(connection));
				for (const socket of connection.database_sockets) {
					ok(socket.connected, 'connected');
				}
			}
		}
	});
});

// Exercises the fallback chain for replication.port: when neither --replication-port nor
// REPLICATION_PORT are supplied, cloneNode must derive the port from HARPER_SET_CONFIG.
// Uses a non-default port so the test fails loudly if cloneNode silently falls back to
// DEFAULT_REPLICATION_PORT (9933) instead of honoring the composed config.
suite('Clone Node - replication.port from HARPER_SET_CONFIG', (ctx) => {
	const REPLICATION_PORT = 19933;

	before(async () => {
		ctx.nodes = [];
		const leaderCtx = {
			name: ctx.name,
			harper: {
				hostname: await getNextAvailableLoopbackAddress(),
			},
		};
		await startHarper(leaderCtx, {
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false },
				replication: {
					port: `${leaderCtx.harper.hostname}:${REPLICATION_PORT}`,
					securePort: null,
				},
			},
			env: {
				HARPER_NO_FLUSH_ON_EXIT: true,
			},
		});
		ctx.nodes.push(leaderCtx.harper);
	});

	after(async () => {
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('cloneNode reads replication.port from HARPER_SET_CONFIG when no flag/env is set', async () => {
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
					port: `${cloneCtx.harper.hostname}:${REPLICATION_PORT}`,
					securePort: null,
				},
			},
			env: {
				HDB_LEADER_URL: `http://${ctx.nodes[0].hostname}:9925`,
				HDB_LEADER_USERNAME: ctx.nodes[0].admin.username,
				HDB_LEADER_PASSWORD: ctx.nodes[0].admin.password,
				ALLOW_SELF_SIGNED: true,
				HARPER_NO_FLUSH_ON_EXIT: true,
				// Intentionally NOT setting REPLICATION_PORT here, and no --replication-port CLI flag is passed,
				// so the only source for the port is composeConfigFromEnv reading HARPER_SET_CONFIG.
			},
		});
		ctx.nodes.push(cloneCtx.harper);

		await waitForAvailableStatus(ctx.nodes[1]);

		// Verify the leader sees the clone connected on the non-default replication port.
		const clusterStatusLeader = await sendOperation(ctx.nodes[0], { operation: 'cluster_status' });
		equal(clusterStatusLeader.connections.length, 1, JSON.stringify(clusterStatusLeader));
		ok(
			clusterStatusLeader.connections[0].url?.includes(`:${REPLICATION_PORT}`),
			`Leader should see clone on port ${REPLICATION_PORT}, got: ${clusterStatusLeader.connections[0].url}`
		);
	});
});

// Failure path: when clone sync does not confirm, the node must publish availability: Unavailable
// (get_status must never carry an absent availability field), must NOT be marked cloned, and must
// stay running and queryable for the control plane.
//
// CLONE_SIMULATE_SYNC_FAILURE drives monitorSync down the unconfirmed-sync branch deterministically.
// Loopback replication is too fast and bidirectional to force a real sync timeout in a test, so this
// diagnostic hook is the only reliable way to assert the failure-branch behavior.
suite('Clone Node - unconfirmed sync leaves node Unavailable and uncloned', (ctx) => {
	before(async () => {
		ctx.nodes = [];
		const leaderCtx = {
			name: ctx.name,
			harper: {
				hostname: await getNextAvailableLoopbackAddress(),
			},
		};
		await startHarper(leaderCtx, {
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false },
				replication: {
					port: leaderCtx.harper.hostname + ':9933',
					securePort: null,
				},
			},
			env: {
				HARPER_NO_FLUSH_ON_EXIT: true,
			},
		});
		ctx.nodes.push(leaderCtx.harper);
	});

	after(async () => {
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('reports Unavailable, stays queryable, and is not marked cloned', async () => {
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
				// Deterministically drive the unconfirmed-sync failure branch in monitorSync.
				CLONE_SIMULATE_SYNC_FAILURE: true,
			},
		});
		ctx.nodes.push(cloneCtx.harper);

		// The failure path publishes Unavailable up front, but status propagation to the operations
		// API can lag on a freshly-started node, so poll rather than checking once after a fixed sleep.
		let availability;
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			try {
				availability = await sendOperation(ctx.nodes[1], { operation: 'get_status', id: 'availability' });
			} catch {}
			if (availability && typeof availability.status === 'string') break;
			await sleep(2000);
		}

		// get_status must respond (node is still running) and must carry a definite availability value —
		// never an absent field, which was the original bug on the failure path.
		ok(availability && typeof availability.status === 'string', 'get_status must always carry an availability status');
		equal(availability.status, 'Unavailable', 'an unconfirmed clone must report availability Unavailable');

		// A node whose sync never confirmed must not be marked cloned, so a restart can retry the clone.
		const config = await sendOperation(ctx.nodes[1], { operation: 'get_configuration' });
		ok(config.cloned !== true, 'an unconfirmed clone must not be marked cloned');
	});
});

// CLONE_SIMULATE_SSH_KEY_FAILURE fails every SSH key request to the leader, retries included.
suite('Clone Node - SSH key clone failure leaves node Unavailable and uncloned', (ctx) => {
	before(async () => {
		ctx.nodes = [];
		const leaderCtx = {
			name: ctx.name,
			harper: {
				hostname: await getNextAvailableLoopbackAddress(),
			},
		};
		await startHarper(leaderCtx, {
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false },
				replication: {
					port: leaderCtx.harper.hostname + ':9933',
					securePort: null,
				},
			},
			env: {
				HARPER_NO_FLUSH_ON_EXIT: true,
			},
		});
		ctx.nodes.push(leaderCtx.harper);
	});

	after(async () => {
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('reports Unavailable, stays queryable, and is not marked cloned', async () => {
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
				CLONE_SIMULATE_SSH_KEY_FAILURE: true,
			},
		});
		ctx.nodes.push(cloneCtx.harper);

		// until setup has given up: before that, a clone still in progress is Unavailable and uncloned too
		let log = '';
		const deadline = Date.now() + 60000;
		while (Date.now() < deadline && !log.includes('failed to clone its SSH keys')) {
			await sleep(1000);
			log = await readLog(ctx.nodes[1]);
		}
		ok(
			log.includes('list_ssh_keys failed on the leader 3 times'),
			'setup must retry the leader request, then stop the clone'
		);

		const availability = await sendOperation(ctx.nodes[1], { operation: 'get_status', id: 'availability' });
		equal(availability?.status, 'Unavailable', 'a clone without its SSH keys must report availability Unavailable');

		const config = await sendOperation(ctx.nodes[1], { operation: 'get_configuration' });
		ok(config.cloned !== true, 'a clone without its SSH keys must not be marked cloned');
		ok(
			!existsSync(join(ctx.nodes[1].dataRootDir, '.cloneAttempt.json')),
			'a stopped clone must retire its attempt, or replication keeps withholding the leader its own records (harper-pro#737)'
		);
	});
});

// A real transfer fault: a file the leader cannot read makes its packer fail partway through the archive,
// so the clone's extraction fails as it would on a dropped transfer.
suite(
	'Clone Node - application clone failure leaves node Unavailable and uncloned, and a restart retries it',
	{ skip: process.getuid?.() === 0 && 'root can read a mode-000 file' },
	(ctx) => {
		const unreadableFile = () => join(ctx.leader.dataRootDir, 'components', 'unreadable-app', 'data.bin');

		before(async () => {
			const leaderCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			await startHarper(leaderCtx, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false },
					replication: { port: leaderCtx.harper.hostname + ':9933', securePort: null },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});
			ctx.leaderCtx = leaderCtx;
			ctx.leader = leaderCtx.harper;
			for (const [file, payload] of [
				['config.yaml', 'rest: true\n'],
				['data.bin', 'leader-only bytes'],
			]) {
				await sendOperation(ctx.leader, { operation: 'set_component_file', project: 'unreadable-app', file, payload });
			}
			chmodSync(unreadableFile(), 0);
		});

		after(async () => {
			await Promise.all([ctx.leaderCtx, ctx.cloneCtx].filter((c) => c?.harper?.process).map((c) => teardownHarper(c)));
		});

		test('reports Unavailable and is not marked cloned, then clones the application once it can', async () => {
			const { operation_token } = await sendOperation(ctx.leader, {
				operation: 'create_authentication_tokens',
				authorization: ctx.leader.admin,
			});
			const cloneCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			ctx.cloneCtx = cloneCtx;
			const cloneOptions = {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false },
					replication: { port: cloneCtx.harper.hostname + ':9933', securePort: null },
				},
				env: {
					HDB_LEADER_URL: `http://${ctx.leader.hostname}:9925`,
					HDB_LEADER_TOKEN: operation_token,
					ALLOW_SELF_SIGNED: true,
					HARPER_NO_FLUSH_ON_EXIT: true,
				},
			};
			await startHarper(cloneCtx, cloneOptions);

			// until setup has given up: before that, a clone still in progress is Unavailable and uncloned too
			let log = '';
			const deadline = Date.now() + 60000;
			while (Date.now() < deadline && !log.includes('failed during setup')) {
				await sleep(1000);
				log = await readLog(cloneCtx.harper);
			}
			ok(log.includes("Failed to clone application 'unreadable-app'"), 'the failed application must be named');
			ok(
				log.includes('Failed to clone 1 of 1 filesystem-only application(s) from the leader: unreadable-app'),
				'a failed application clone must stop clone setup'
			);

			const availability = await sendOperation(cloneCtx.harper, { operation: 'get_status', id: 'availability' });
			equal(availability?.status, 'Unavailable', 'a clone missing an application must report availability Unavailable');
			const config = await sendOperation(cloneCtx.harper, { operation: 'get_configuration' });
			ok(config.cloned !== true, 'a clone missing an application must not be marked cloned');
			ok(
				!existsSync(join(cloneCtx.harper.dataRootDir, '.cloneAttempt.json')),
				'a clone stopped by an application must retire its attempt (harper-pro#737)'
			);

			chmodSync(unreadableFile(), 0o644);
			await killHarper(cloneCtx);
			await startHarper(cloneCtx, cloneOptions);
			await waitForAvailableStatus(cloneCtx.harper);

			const retried = await sendOperation(cloneCtx.harper, { operation: 'get_configuration' });
			equal(retried.cloned, true, 'the retried clone must be marked cloned');
			equal(
				readFileSync(join(cloneCtx.harper.dataRootDir, 'components', 'unreadable-app', 'data.bin'), 'utf8'),
				'leader-only bytes',
				'the retried clone must hold the application'
			);
		});
	}
);
