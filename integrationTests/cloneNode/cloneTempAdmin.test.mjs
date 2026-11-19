/**
 * harper-pro#1451: a token clone installs `clone-temp-admin` and deletes it once synced, so its leader holds that
 * user's deleted row. A node that later joins the leader by base copy must keep `system.hdb_user` provable for
 * record locks: the copy carries the row as a delete (harper-pro#1331), not as a put with no record, which the
 * joiner would record as a permanent replication hole.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, waitForCondition } from '../cluster/clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const TEMP_ADMIN = 'clone-temp-admin';
// sorts after TEMP_ADMIN, so a copy walk that delivers it has already walked TEMP_ADMIN's row
const WITNESS_USER = 'zz-copy-witness';
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

suite('Clone Node - temporary admin', (ctx) => {
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

		await sendOperation(leader, {
			operation: 'add_user',
			role: 'super_user',
			username: WITNESS_USER,
			password: `witness-${Date.now()}`,
			active: true,
		});
		const copyJoiner = await startClone(ctx, leader, {
			HDB_LEADER_USERNAME: leader.admin.username,
			HDB_LEADER_PASSWORD: leader.admin.password,
		});
		nodes.push(copyJoiner);
		await waitForCloned(copyJoiner);
		await waitForCondition(async (signal) => (await usernames(copyJoiner, signal)).includes(WITNESS_USER), {
			timeoutMs: WAIT_MS,
			description: `${copyJoiner.hostname} to copy ${WITNESS_USER} from the leader`,
		});

		for (const node of nodes) {
			const locks = (await sendOperation(node, { operation: 'cluster_status' })).recordLocks?.system;
			assert.ok(
				Array.isArray(locks?.poisoned),
				`${node.hostname} reports no record-lock poison state for system: ${JSON.stringify(locks)}`
			);
			assert.deepEqual(locks.poisoned, [], `${node.hostname} records a replication hole in system`);
			assert.ok(!(await usernames(node)).includes(TEMP_ADMIN), `${TEMP_ADMIN} is back on ${node.hostname}`);
		}
	});
});
