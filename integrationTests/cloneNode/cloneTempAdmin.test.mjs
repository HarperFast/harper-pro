// harper-pro#1451
import { suite, test, after } from 'node:test';
import assert from 'node:assert';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, waitForCondition } from '../cluster/clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const STORED_ROW_FIXTURE = join(import.meta.dirname, 'fixture', 'stored-row');
const TEMP_ADMIN = 'clone-temp-admin';
const WAIT_MS = 180_000;

suite('Clone Node - temporary admin', { skip: isLMDB && 'cluster record locks require RocksDB' }, (ctx) => {
	const contexts = [];

	after(() => stopAndTeardownNodes(contexts.map((context) => context.harper)));

	async function startNode({ replication, env, harperBinPath, components } = {}) {
		const parentDir = process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir();
		const hostname = await getNextAvailableLoopbackAddress();
		const context = {
			name: ctx.name,
			harper: { hostname, dataRootDir: await mkdtemp(join(parentDir, 'harper-integration-test-')) },
		};
		// registered before the start, so teardown removes the root of a node that failed to start
		contexts.push(context);
		if (components)
			await cp(components, join(context.harper.dataRootDir, 'components', 'stored-row'), { recursive: true });
		await startHarper(context, {
			harperBinPath,
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false },
				replication: { port: hostname + ':9933', securePort: null, ...replication },
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true, ...env },
		});
		return context.harper;
	}

	function startClone(leader, env, harperBinPath) {
		return startNode({
			harperBinPath,
			env: { HDB_LEADER_URL: `http://${leader.hostname}:9925`, ALLOW_SELF_SIGNED: true, ...env },
		});
	}

	function waitForCloned(node) {
		return waitForCondition(
			async (signal) => (await sendOperation(node, { operation: 'get_configuration' }, { signal })).cloned === true,
			{ timeoutMs: WAIT_MS, description: `${node.hostname} to finish cloning` }
		);
	}

	async function storedTempAdmin(node, signal) {
		const response = await fetch(`${node.httpURL}/StoredRow`, {
			method: 'POST',
			headers: {
				'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ database: 'system', table: 'hdb_user', id: TEMP_ADMIN }),
			signal,
		});
		return response.status === 200 ? response.json() : undefined;
	}

	async function poisonedPairs(node) {
		const locks = await waitForCondition(
			async (signal) => {
				const status = await sendOperation(node, { operation: 'cluster_status' }, { signal });
				return Array.isArray(status.recordLocks?.system?.poisoned) && status.recordLocks.system;
			},
			{ timeoutMs: WAIT_MS, description: `${node.hostname} to report its record-lock state for system` }
		);
		return locks.poisoned;
	}

	test('a node that copies from a leader holding the deleted temporary admin keeps hdb_user provable', async () => {
		const leader = await startNode({ replication: { recordLocks: true }, components: STORED_ROW_FIXTURE });
		const { operation_token } = await sendOperation(
			leader,
			{ operation: 'create_authentication_tokens', authorization: leader.admin, expires_in: '10Minutes' },
			{ signal: AbortSignal.timeout(30_000) }
		);
		const tokenClone = await startClone(
			leader,
			{ HDB_LEADER_TOKEN: operation_token },
			join(import.meta.dirname, 'fixture', 'harperWithoutHarnessAdmin.mjs')
		);
		await waitForCloned(tokenClone);
		const deleted = await waitForCondition(
			async (signal) => {
				const row = await storedTempAdmin(leader, signal);
				return row?.stored && !row.present && row;
			},
			{ timeoutMs: WAIT_MS, description: `the leader to apply the token clone's delete of ${TEMP_ADMIN}` }
		);
		assert.ok(deleted.fullWriteHead, `premise: the leader holds ${TEMP_ADMIN} as a flagged tombstone`);

		const copyJoiner = await startClone(leader, {
			HDB_LEADER_USERNAME: leader.admin.username,
			HDB_LEADER_PASSWORD: leader.admin.password,
		});
		await waitForCloned(copyJoiner);
		const copied = await waitForCondition(async (signal) => storedTempAdmin(copyJoiner, signal), {
			timeoutMs: WAIT_MS,
			description: `${copyJoiner.hostname} to serve the cloned StoredRow application`,
		});

		for (const node of [leader, tokenClone, copyJoiner])
			assert.deepEqual(await poisonedPairs(node), [], `${node.hostname} records a replication hole in system`);
		assert.deepEqual(
			{ stored: copied.stored, present: copied.present, version: copied.version },
			{ stored: true, present: false, version: deleted.version },
			`${copyJoiner.hostname} must hold the leader's deletion of ${TEMP_ADMIN}`
		);
	});
});
