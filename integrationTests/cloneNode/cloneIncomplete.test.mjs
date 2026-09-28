import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { readLog, restartNode, stopNodeProcess, sendOperation, waitForCondition } from '../cluster/clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const DB = 'data';
const TABLE = 'CloneIntegrity';
const POISON_PREFIX = 'poison-copy-';

function nodeConfig(hostname, env = {}) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, level: 'debug' },
			replication: { port: `${hostname}:9933`, securePort: null },
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true, ...env },
	};
}

async function rowExists(node, id, signal) {
	try {
		const rows = await sendOperation(
			node,
			{
				operation: 'search_by_hash',
				database: DB,
				table: TABLE,
				hash_values: [id],
				get_attributes: ['id'],
			},
			{ signal }
		);
		return rows.length === 1;
	} catch {
		return false;
	}
}

async function incompleteSocket(node, signal) {
	try {
		const status = await sendOperation(node, { operation: 'cluster_status' }, { signal });
		for (const connection of status.connections ?? []) {
			for (const socket of connection.database_sockets ?? []) {
				if (socket.database === DB && socket.cloneIncomplete?.state === 'incomplete') return socket;
			}
		}
	} catch {}
}

const incompleteOutcomeCount = (log) =>
	(log.match(/completed with one or more undecodable copy records/g) ?? []).length;

suite('Clone Node - incomplete copy stays Unavailable', { timeout: 300_000 }, (ctx) => {
	before(async () => {
		ctx.nodes = [];
		const leaderCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await startHarper(leaderCtx, nodeConfig(leaderCtx.harper.hostname));
		ctx.leader = leaderCtx.harper;
		ctx.nodes.push(ctx.leader);

		await sendOperation(ctx.leader, {
			operation: 'create_table',
			database: DB,
			table: TABLE,
			primary_key: 'id',
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'value', type: 'String' },
			],
		});
		await sendOperation(ctx.leader, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [
				{ id: 'before-drop', value: 'present' },
				{ id: `${POISON_PREFIX}row`, value: 'skipped' },
				{ id: 'after-drop', value: 'present' },
			],
		});
	});

	after(async () => {
		if (ctx.cloneRestarted) await stopNodeProcess(ctx.clone).catch(() => {});
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node }).catch(() => {})));
	});

	test('finishes copying, persists the short-clone verdict, and retains it across restart', async () => {
		const cloneCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		ctx.setupTraceFile = join(ctx.leader.dataRootDir, 'incomplete-clone-setup-trace.log');
		await startHarper(
			cloneCtx,
			nodeConfig(cloneCtx.harper.hostname, {
				HDB_LEADER_URL: `http://${ctx.leader.hostname}:9925`,
				HDB_LEADER_USERNAME: ctx.leader.admin.username,
				HDB_LEADER_PASSWORD: ctx.leader.admin.password,
				ALLOW_SELF_SIGNED: true,
				HARPER_TEST_DECODE_FAIL_RECORD_PREFIX: POISON_PREFIX,
				CLONE_SETUP_TRACE_FILE: ctx.setupTraceFile,
			})
		);
		ctx.clone = cloneCtx.harper;
		ctx.nodes.push(ctx.clone);

		const socket = await waitForCondition((signal) => incompleteSocket(ctx.clone, signal), {
			timeoutMs: 120_000,
			pollMs: 500,
			description: 'the completed copy to publish cloneIncomplete',
		});
		assert.equal(socket.cloneIncomplete.table, TABLE);
		assert.equal(socket.cloneIncomplete.count, 1);
		assert.equal(await rowExists(ctx.clone, 'after-drop'), true, 'copy must finish past the dropped row');
		assert.equal(await rowExists(ctx.clone, `${POISON_PREFIX}row`), false, 'the injected row must be absent');

		const availability = await sendOperation(ctx.clone, { operation: 'get_status', id: 'availability' });
		assert.equal(availability.status, 'Unavailable');
		const config = await sendOperation(ctx.clone, { operation: 'get_configuration' });
		assert.notEqual(config.cloned, true);
		await waitForCondition(
			async () =>
				!existsSync(join(ctx.clone.dataRootDir, '.cloneAttempt.json')) &&
				existsSync(join(ctx.clone.dataRootDir, 'tmp', 'clone-sync-started.json')) &&
				/completed with one or more undecodable copy records/.test(await readLog(ctx.clone)),
			{
				timeoutMs: 30_000,
				pollMs: 250,
				description: 'the incomplete-clone verdict to retire the clone attempt and retain setup state',
			}
		);

		await sendOperation(ctx.leader, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [{ id: 'live-after-incomplete', value: 'still replicating' }],
		});
		await waitForCondition((signal) => rowExists(ctx.clone, 'live-after-incomplete', signal), {
			timeoutMs: 60_000,
			pollMs: 500,
			description: 'live replication to continue after the incomplete copy',
		});

		await restartNode(ctx.clone);
		ctx.cloneRestarted = true;
		await waitForCondition((signal) => incompleteSocket(ctx.clone, signal), {
			timeoutMs: 120_000,
			pollMs: 500,
			description: 'cloneIncomplete to survive restart',
		});
		await waitForCondition(async () => incompleteOutcomeCount(await readLog(ctx.clone)) >= 2, {
			timeoutMs: 30_000,
			pollMs: 250,
			description: 'the restarted clone monitor to re-emit the terminal incomplete verdict',
		});
		assert.equal(
			readFileSync(ctx.setupTraceFile, 'utf8').trim().split('\n').length,
			1,
			'an unrepaired restart must not replay one-shot clone setup'
		);
		const restartedAvailability = await sendOperation(ctx.clone, {
			operation: 'get_status',
			id: 'availability',
		});
		assert.equal(restartedAvailability.status, 'Unavailable');
	});
});
