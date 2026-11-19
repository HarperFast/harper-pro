// harper-pro#1451
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { readLog, sendOperation, stopAndTeardownNodes, waitForCondition } from '../cluster/clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const TEMP_ADMIN = 'clone-temp-admin';
// a copied tombstone has no audit entry and no read path, so the joiner's debug log is where its arrival shows
const RECEIVED_TEMP_ADMIN = /received replication message (\S+) id clone-temp-admin /g;
const WAIT_MS = 180_000;

function nodeConfig(hostname, replication) {
	return {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, auditLog: true },
		replication: { port: hostname + ':9933', securePort: null, ...replication },
	};
}

async function startClone(ctx, leader, env, harperBinPath) {
	const context = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
	await startHarper(context, {
		harperBinPath,
		config: nodeConfig(context.harper.hostname),
		env: {
			HDB_LEADER_URL: `http://${leader.hostname}:9925`,
			ALLOW_SELF_SIGNED: true,
			HARPER_NO_FLUSH_ON_EXIT: true,
			...env,
		},
	});
	return context.harper;
}

function waitForCloned(node) {
	return waitForCondition(
		async (signal) => (await sendOperation(node, { operation: 'get_configuration' }, { signal })).cloned === true,
		{ timeoutMs: WAIT_MS, description: `${node.hostname} to finish cloning` }
	);
}

async function usernames(node, signal) {
	return (await sendOperation(node, { operation: 'list_users' }, { signal })).map((user) => user.username);
}

suite('Clone Node - temporary admin', { skip: isLMDB && 'cluster record locks require RocksDB' }, (ctx) => {
	const nodes = [];

	before(async () => {
		const context = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await startHarper(context, {
			config: nodeConfig(context.harper.hostname, { recordLocks: true }),
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});
		nodes.push(context.harper);
	});

	after(() => stopAndTeardownNodes(nodes));

	test('a node that copies from a leader holding the deleted temporary admin keeps hdb_user provable', async () => {
		const [leader] = nodes;
		const { operation_token } = await sendOperation(leader, {
			operation: 'create_authentication_tokens',
			authorization: leader.admin,
			expires_in: '10Minutes',
		});
		const tokenClone = await startClone(
			ctx,
			leader,
			{ HDB_LEADER_TOKEN: operation_token },
			join(import.meta.dirname, 'fixture', 'harperWithoutHarnessAdmin.mjs')
		);
		nodes.push(tokenClone);
		await waitForCloned(tokenClone);
		await waitForCondition(
			async (signal) => {
				const history = await sendOperation(
					leader,
					{
						operation: 'read_audit_log',
						database: 'system',
						table: 'hdb_user',
						search_type: 'hash_value',
						search_values: [TEMP_ADMIN],
					},
					{ signal }
				);
				return history[TEMP_ADMIN]?.some((entry) => entry.operation === 'delete');
			},
			{ timeoutMs: WAIT_MS, description: `the leader to apply the token clone's delete of ${TEMP_ADMIN}` }
		);

		const copyJoiner = await startClone(ctx, leader, {
			HDB_LEADER_USERNAME: leader.admin.username,
			HDB_LEADER_PASSWORD: leader.admin.password,
		});
		nodes.push(copyJoiner);
		await waitForCloned(copyJoiner);
		const receivedTypes = await waitForCondition(
			async () => {
				const types = [...(await readLog(copyJoiner)).matchAll(RECEIVED_TEMP_ADMIN)].map((match) => match[1]);
				return types.length > 0 && types;
			},
			{ timeoutMs: WAIT_MS, description: `${copyJoiner.hostname} to copy the leader's ${TEMP_ADMIN} row` }
		);
		assert.ok(
			receivedTypes.every((type) => type === 'delete'),
			`${copyJoiner.hostname} received ${TEMP_ADMIN} as ${receivedTypes}, not only as a deletion`
		);

		for (const node of nodes) {
			const locks = await waitForCondition(
				async (signal) => {
					const status = await sendOperation(node, { operation: 'cluster_status' }, { signal });
					return Array.isArray(status.recordLocks?.system?.poisoned) && status.recordLocks.system;
				},
				{ timeoutMs: WAIT_MS, description: `${node.hostname} to report its record-lock state for system` }
			);
			assert.deepEqual(locks.poisoned, [], `${node.hostname} records a replication hole in system`);
			assert.ok(
				!(await usernames(node, AbortSignal.timeout(30_000))).includes(TEMP_ADMIN),
				`${TEMP_ADMIN} is back on ${node.hostname}`
			);
		}
	});
});
