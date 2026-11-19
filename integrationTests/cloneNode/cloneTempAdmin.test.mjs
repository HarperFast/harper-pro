// harper-pro#1451
import { suite, test, after } from 'node:test';
import assert from 'node:assert';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	startHarper,
	killHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { sendOperation, waitForCondition } from '../cluster/clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const STORED_ROW_FIXTURE = join(import.meta.dirname, 'fixture', 'stored-row');
const TEMP_ADMIN = 'clone-temp-admin';
const WAIT_MS = 180_000;

const SUITE_OPTIONS = { timeout: 900_000, skip: isLMDB && 'cluster record locks require RocksDB' };

suite('Clone Node - temporary admin', SUITE_OPTIONS, (ctx) => {
	const contexts = [];

	after(() => Promise.all(contexts.map((context) => teardownHarper(context))));

	async function startNode({ replication, env, harperBinPath, components } = {}) {
		const parentDir = process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir();
		const hostname = await getNextAvailableLoopbackAddress();
		const context = {
			name: ctx.name,
			harper: { hostname, dataRootDir: await mkdtemp(join(parentDir, 'harper-integration-test-')) },
		};
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
		let response;
		try {
			response = await fetch(`${node.httpURL}/StoredRow`, {
				method: 'POST',
				headers: {
					'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ database: 'system', table: 'hdb_user', id: TEMP_ADMIN }),
				signal,
			});
		} catch (error) {
			if (signal.aborted) throw error;
			return undefined;
		}
		if (response.status === 200) return response.json();
		const body = await response.text();
		if (response.status === 404 || response.status === 503) return undefined;
		throw new Error(`StoredRow on ${node.hostname} answered ${response.status}: ${body}`);
	}

	async function systemPoison(node, signal) {
		const status = await sendOperation(node, { operation: 'cluster_status' }, { signal });
		return status.recordLocks?.system?.poisoned;
	}

	async function poisonedPairs(node) {
		return waitForCondition(
			async (signal) => {
				const poisoned = await systemPoison(node, signal);
				return Array.isArray(poisoned) && poisoned;
			},
			{ timeoutMs: WAIT_MS, description: `${node.hostname} to report its record-lock state for system` }
		);
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
		assert.deepEqual(
			{ fullWriteHead: deleted.fullWriteHead, origin: deleted.origin, audited: deleted.audited },
			{ fullWriteHead: true, origin: tokenClone.hostname, audited: true },
			`premise: the leader holds the token clone's deletion of ${TEMP_ADMIN} as a flagged tombstone`
		);
		assert.deepEqual(
			await poisonedPairs(tokenClone),
			[],
			`${tokenClone.hostname} records a replication hole in system`
		);
		// the leader is then the joiner's only source for the deletion; the token clone keeps its address until
		// teardown, since a joiner on that address would take its node name
		await killHarper(
			contexts.find((context) => context.harper === tokenClone),
			{ graceMs: 30_000 }
		);
		assert.ok(
			tokenClone.process.exitCode !== null || tokenClone.process.signalCode !== null,
			`${tokenClone.hostname} did not exit`
		);

		const copyJoiner = await startClone(leader, {
			HDB_LEADER_USERNAME: leader.admin.username,
			HDB_LEADER_PASSWORD: leader.admin.password,
		});
		await waitForCloned(copyJoiner);
		const copied = await waitForCondition(
			async (signal) => {
				const row = await storedTempAdmin(copyJoiner, signal);
				if (row?.stored) return row;
				if (row && (await systemPoison(copyJoiner, signal))?.length) return row;
			},
			{ timeoutMs: WAIT_MS, description: `${copyJoiner.hostname} to copy the leader's ${TEMP_ADMIN} row` }
		);

		for (const node of [leader, copyJoiner])
			assert.deepEqual(await poisonedPairs(node), [], `${node.hostname} records a replication hole in system`);
		assert.deepEqual(
			copied,
			{
				stored: true,
				present: false,
				version: deleted.version,
				fullWriteHead: true,
				origin: tokenClone.hostname,
				audited: false,
			},
			`${copyJoiner.hostname} must hold the deletion of ${TEMP_ADMIN} as the leader's base copy delivered it`
		);
	});
});
