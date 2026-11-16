// The cluster runs an inverted custom map: a clone that started its own default map would conflict with it.
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { existsSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { killHarper, startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	logMark,
	readLog,
	readLogSince,
	restartHttpWorkers,
	sendOperation,
	stopAndTeardownNodes,
	waitForCondition,
} from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const FIXTURE = join(import.meta.dirname, 'fixture-clone-sharded');
const SHARD_OPTION = '--shard or CLONE_SHARD';
const ROW_COUNT = 20;
// Longer than two monitor ticks (3 s each), so a monitor that would finish has had the chance to.
const MONITOR_TICKS_MS = 7000;

const nodeConfig = (hostname, replication) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false, stdStreams: false, level: 'warn' },
	replication: { securePort: hostname + ':9933', ...replication },
});
const authorization = (node) =>
	'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64');

async function rest(node, path, { method = 'GET', body, signal = AbortSignal.timeout(30_000) } = {}) {
	const response = await fetch(`${node.httpURL}/${path}`, {
		method,
		signal,
		headers: { 'Authorization': authorization(node), 'Content-Type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	return { status: response.status, data: text ? JSON.parse(text) : undefined };
}

async function localRows(node, signal) {
	const { status, data } = await rest(node, 'CloneLocalRows', { signal });
	assert.equal(status, 200, JSON.stringify(data));
	return data.sort((a, b) => a.id.localeCompare(b.id));
}

const clusterStatus = (node, signal) => sendOperation(node, { operation: 'cluster_status' }, { signal });

const availability = async (node) =>
	(await sendOperation(node, { operation: 'get_status', id: 'availability' }).catch(() => undefined))?.status;

async function waitForAvailable(node) {
	await waitForCondition(async () => (await availability(node)) === 'Available', {
		timeoutMs: 180_000,
		description: `${node.hostname} to become Available`,
	});
}

async function waitForLog(node, text) {
	await waitForCondition(async () => (await readLog(node)).includes(text), {
		timeoutMs: 180_000,
		description: `${node.hostname} to log "${text}"`,
	});
}

async function waitForHeldCopy(holdDirectory) {
	await waitForCondition(() => existsSync(join(holdDirectory, 'held')), {
		timeoutMs: 180_000,
		pollMs: 200,
		description: 'a copy to hold at COPY_START',
	});
}

suite('Clone from a statically sharded leader', { timeout: 900_000 }, (ctx) => {
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);
	let leader;
	let coOwner;
	let digest;
	const owned = {};

	async function startClone(env, context) {
		if (!context) {
			context = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			contexts.push(context);
		}
		const { operation_token: token } = await sendOperation(leader, {
			operation: 'create_authentication_tokens',
			authorization: leader.admin,
			expires_in: '15Minutes',
		});
		await startHarper(context, {
			config: nodeConfig(context.harper.hostname),
			env: {
				HDB_LEADER_URL: `http://${leader.hostname}:9925`,
				HDB_LEADER_TOKEN: token,
				ALLOW_SELF_SIGNED: true,
				HARPER_NO_FLUSH_ON_EXIT: true,
				...env,
			},
		});
		return context;
	}

	// Stopped, not torn down: teardown recycles the address, and a node reusing a removed node's name is refused.
	async function retire(context) {
		await killHarper(context);
		// a stopped node cannot be drained, so the removal is forced
		await sendOperation(leader, { operation: 'remove_node', hostname: context.harper.hostname, force: true });
	}

	async function assertServes(node, shard) {
		assert.deepEqual(await localRows(node), owned[shard], `${node.hostname} holds exactly shard ${shard}'s rows`);
		const other = owned[shard === 0 ? 1 : 0][0];
		assert.deepEqual(
			(await rest(node, `CloneRows/${other.id}`)).data,
			other,
			'a row it does not own is read from its owner'
		);
		const status = await clusterStatus(node);
		assert.equal(status.sharding.data.state, 'available', JSON.stringify(status.sharding.data));
		assert.equal(status.sharding.data.digest, digest, "the leader's map, not one of its own");
		const configuration = await sendOperation(node, { operation: 'get_configuration' });
		assert.equal(configuration.replication.shard, shard);
		assert.deepEqual(configuration.replication.shards, [0, 1]);
		assert.equal(configuration.cloned, true);
		assert.deepEqual((await clusterStatus(leader)).sharding.data.errors, [], 'the clone did not hold the leader');
	}

	before(async () => {
		for (const shard of [0, 1]) {
			const context = {
				name: ctx.name,
				harper: {
					hostname: await getNextAvailableLoopbackAddress(),
					dataRootDir: await mkdtemp(
						join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
					),
				},
			};
			contexts.push(context);
			await startHarper(context, {
				config: nodeConfig(context.harper.hostname, { shard, shards: [0, 1], databases: '*' }),
			});
		}
		[leader, coOwner] = nodes();
		const { operation_token: token } = await sendOperation(leader, {
			operation: 'create_authentication_tokens',
			authorization: leader.admin,
		});
		await sendOperation(coOwner, {
			operation: 'add_node',
			hostname: leader.hostname,
			authorization: 'Bearer ' + token,
			rejectUnauthorized: false,
		});
		await sendOperation(leader, { operation: 'create_database', database: 'data' });
		({ digest } = await sendOperation(leader, {
			operation: 'initialize_shard_map',
			database: 'data',
			slots: 10,
			ranges: [
				{ start: 0, end: 5, shard: 1 },
				{ start: 5, end: 10, shard: 0 },
			],
		}));
		await waitForCondition(
			async (signal) =>
				(
					await sendOperation(
						coOwner,
						{
							operation: 'search_by_id',
							database: 'system',
							table: 'hdb_residency_slots',
							ids: ['data'],
							get_attributes: ['digest'],
						},
						{ signal }
					)
				)[0]?.digest === digest,
			{ description: 'the custom map to reach the co-owner' }
		);
		for (const node of nodes()) {
			await cp(FIXTURE, join(node.dataRootDir, 'components', basename(FIXTURE)), { recursive: true });
			await restartHttpWorkers(node);
		}
		await waitForCondition(
			async (signal) =>
				(await Promise.all(nodes().map((node) => clusterStatus(node, signal).catch(() => undefined)))).every(
					(status) =>
						status?.sharding?.data?.state === 'available' &&
						status.connections.some((peer) =>
							peer.database_sockets.some((socket) => socket.database === 'data' && socket.connected)
						)
				),
			{ timeoutMs: 180_000, description: 'the founding members to become ready' }
		);
		for (let i = 0; i < ROW_COUNT; i++) {
			const id = `row-${i}`;
			const { status, data } = await rest(leader, `CloneRows/${id}`, {
				method: 'PUT',
				body: { id, body: `body-${i}` },
			});
			assert.ok(status >= 200 && status < 300, JSON.stringify(data));
		}
		await waitForCondition(
			async (signal) => {
				owned[0] = await localRows(leader, signal);
				owned[1] = await localRows(coOwner, signal);
				return owned[0].length + owned[1].length === ROW_COUNT;
			},
			{ description: 'every row to reach its owners' }
		);
		assert.ok(owned[0].length && owned[1].length, 'both shards own rows');
	});

	after(() => stopAndTeardownNodes(nodes()));

	let refused;

	test('refuses a clone with no shard option, before it writes config or joins', async () => {
		refused = await startClone({});
		const node = refused.harper;
		await waitForLog(node, SHARD_OPTION);
		assert.match(await readLog(node), /The leader is sharded and a clone does not inherit its shard/);
		assert.equal(await availability(node), 'Unavailable');
		const configuration = await sendOperation(node, { operation: 'get_configuration' });
		assert.equal(configuration.cloned, false);
		assert.equal(configuration.replication.shard, undefined);
		assert.equal(configuration.replication.shards, undefined);
		const { connections } = await clusterStatus(leader);
		assert.ok(!connections.some((peer) => peer.name === node.hostname), 'the leader never heard from it');
		assert.ok(
			!existsSync(join(node.dataRootDir, 'tmp', 'clone-sync-started.json')),
			'a restart days later must not inherit this attempt as spent time'
		);
	});

	test('an explicit shard across shards completes only once its owned copy from the co-owner does', async () => {
		const holdDirectory = await mkdtemp(join(tmpdir(), 'clone-shard-hold-'));
		const { harper: node } = await startClone({
			CLONE_SHARD: 1,
			HARPER_TEST_HOLD_COPY_START_DB: 'data',
			HARPER_TEST_HOLD_COPY_START_DIR: holdDirectory,
			HARPER_TEST_HOLD_COPY_START_PEER: coOwner.hostname,
		});
		try {
			await waitForHeldCopy(holdDirectory);
			await waitForCondition(
				async (signal) => {
					const peer = (await clusterStatus(node, signal)).connections.find((peer) => peer.name === leader.hostname);
					return peer?.database_sockets.some((socket) => socket.database === 'data' && socket.lastReceivedVersion > 0);
				},
				{ description: "the leader's socket to pass the clone's target while the co-owner's copy is held" }
			);
			await delay(MONITOR_TICKS_MS);
			assert.equal(await availability(node), 'Unavailable', 'Available with its owned rows still held back');
			assert.notEqual((await sendOperation(node, { operation: 'get_configuration' })).cloned, true);
		} finally {
			writeFileSync(join(holdDirectory, 'release'), 'go');
		}
		await waitForAvailable(node);
		await waitForLog(node, 'Clone shard: shard 1 from --shard or CLONE_SHARD');
		assert.doesNotMatch(await readLog(node), /Pre-created table 'data\./, 'a plain table cannot take its policy later');
		await waitForCondition(
			async () => (await sendOperation(node, { operation: 'get_configuration' })).cloned === true,
			{
				description: 'the clone to finish',
			}
		);
		await assertServes(node, 1);

		// The leader's leg was held on its copy-stall backoff while the owned copy ran. If finishing that copy did not
		// wake it, the clone would hold this write back for the rest of the hold (a minute here, up to 15 on a long copy).
		const fresh = Array.from({ length: 8 }, (_, i) => ({ id: `fresh-${i}`, body: `fresh-body-${i}` }));
		for (const row of fresh) {
			const { status, data } = await rest(leader, `CloneRows/${row.id}`, { method: 'PUT', body: row });
			assert.ok(status >= 200 && status < 300, JSON.stringify(data));
		}
		const freshOn = async (owner, signal) =>
			(await localRows(owner, signal)).filter((row) => row.id.startsWith('fresh-'));
		await waitForCondition(
			async (signal) =>
				(await freshOn(leader, signal)).length + (await freshOn(coOwner, signal)).length === fresh.length,
			{ description: 'the founding owners to hold the new rows' }
		);
		owned[0] = await localRows(leader);
		owned[1] = await localRows(coOwner);
		await waitForCondition(
			async (signal) => JSON.stringify(await localRows(node, signal)) === JSON.stringify(owned[1]),
			{ timeoutMs: 20_000, description: "the leader's new writes to reach the clone's owned slots promptly" }
		);

		await waitForCondition(
			async (signal) =>
				(await clusterStatus(leader, signal)).connections.some(
					(peer) => peer.name === node.hostname && peer.database_sockets.some((socket) => socket.connected)
				),
			{ description: 'the leader to see the clone live' }
		);
	});

	test('"auto" on the refused root picks the shard with fewer live members', async () => {
		await killHarper(refused);
		const node = (await startClone({ CLONE_SHARD: 'auto' }, refused)).harper;
		await waitForAvailable(node);
		await waitForLog(node, 'Clone shard: shard 0 from "auto"; live members: 0=1, 1=2');
		await waitForCondition(
			async () => (await sendOperation(node, { operation: 'get_configuration' })).cloned === true,
			{
				description: 'the clone to finish',
			}
		);
		await assertServes(node, 0);
	});

	test("a root an older binary's failed clone left: refused until confirmed, then copies with no assertion", async () => {
		const context = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		contexts.push(context);
		await startHarper(context, { config: nodeConfig(context.harper.hostname) });
		await sendOperation(context.harper, {
			operation: 'create_table',
			database: 'data',
			table: 'CloneRows',
			primary_key: 'id',
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'body', type: 'String' },
			],
		});
		await sendOperation(context.harper, {
			operation: 'set_configuration',
			replication_shard: 1,
			replication_shards: [0, 1],
		});
		const { dataRootDir } = context.harper;
		await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true });
		await killHarper(context);
		await mkdir(join(dataRootDir, 'tmp'), { recursive: true });
		await writeFile(
			join(dataRootDir, 'tmp', 'clone-sync-started.json'),
			JSON.stringify({
				leaderURL: `http://${leader.hostname}:9925`,
				startedAt: Date.now() - 48 * 60 * 60 * 1000, // past any ceiling: it must not be charged to this clone
				replicationEstablished: true,
				setupComplete: false,
			})
		);

		// Twice: the refusal must still stand at the next start, not be taken for this binary's own earlier attempt.
		for (let start = 1; start <= 2; start++) {
			const mark = await logMark(context.harper);
			await startClone({}, context);
			await waitForCondition(async () => (await readLogSince(context.harper, mark)).includes('may be the leader'), {
				timeoutMs: 180_000,
				description: `start ${start} to refuse the shard it found`,
			});
			assert.equal(await availability(context.harper), 'Unavailable');
			await killHarper(context);
		}

		const holdDirectory = await mkdtemp(join(tmpdir(), 'clone-shard-hold-'));
		await startClone(
			{
				CLONE_SHARD: 1,
				HARPER_TEST_HOLD_COPY_START_DB: 'data',
				HARPER_TEST_HOLD_COPY_START_DIR: holdDirectory,
			},
			context
		);
		const node = context.harper;
		try {
			await waitForHeldCopy(holdDirectory);
			await waitForCondition(
				async (signal) => (await clusterStatus(node, signal)).sharding?.data?.recovery?.phase === 'recovery-required',
				{ description: 'the clone to report it is waiting on its owned copy' }
			);
			assert.match(
				(await clusterStatus(node)).sharding.data.recovery.reason,
				/Waiting for a certified same-shard copy/
			);
		} finally {
			writeFileSync(join(holdDirectory, 'release'), 'go');
		}
		await waitForAvailable(node);
		await waitForCondition(
			async () => (await sendOperation(node, { operation: 'get_configuration' })).cloned === true,
			{
				description: 'the clone to finish',
			}
		);
		await assertServes(node, 1);
		await retire(context);
	});

	test("certificate auth reads the leader's members and shard map over the replication socket", async () => {
		const context = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		contexts.push(context);
		// Joining has the leader sign this node's certificate and record it, which is what a certificate clone relies
		// on; system alone keeps it from taking on any origin history in the sharded database first.
		await startHarper(context, { config: nodeConfig(context.harper.hostname, { databases: ['system'] }) });
		const { operation_token: token } = await sendOperation(leader, {
			operation: 'create_authentication_tokens',
			authorization: leader.admin,
		});
		await sendOperation(context.harper, {
			operation: 'add_node',
			hostname: leader.hostname,
			authorization: 'Bearer ' + token,
			rejectUnauthorized: false,
		});
		await killHarper(context);

		await startHarper(context, {
			config: nodeConfig(context.harper.hostname, { shard: 1, databases: '*' }),
			env: {
				HDB_LEADER_URL: `https://${leader.hostname}:9925`,
				ALLOW_SELF_SIGNED: true,
				HARPER_NO_FLUSH_ON_EXIT: true,
			},
		});
		const node = context.harper;
		await waitForLog(node, "Clone shard: shard 1 from this node's configuration");
		await waitForLog(node, "Installed the leader's shard map for 'data'");
		await waitForAvailable(node);
		await waitForCondition(
			async () => (await sendOperation(node, { operation: 'get_configuration' })).cloned === true,
			{
				description: 'the clone to finish',
			}
		);
		await assertServes(node, 1);
		await retire(context);
	});

	test('a copy that keeps failing fails the clone at its sync timeout, naming the database and the error', async () => {
		const { harper: node } = await startClone({
			CLONE_SHARD: 1,
			CLONE_SYNC_TIMEOUT: 20_000,
			HARPER_TEST_COPY_APPLY_FAILURE_KEY: owned[1][0].id,
		});
		await waitForLog(node, 'did not complete synchronization');
		const log = await readLog(node);
		const failure = `refusing copy row ${owned[1][0].id}`;
		assert.match(log, new RegExp(`Clone sync did not finish for database data: .*${failure}`));
		assert.match(
			log,
			new RegExp(`Sync incomplete; .*database data: copy failed \\d+ times?; last error: .*${failure}`)
		);
		assert.equal(await availability(node), 'Unavailable');
		assert.equal((await sendOperation(node, { operation: 'get_configuration' })).cloned, false);
	});
});
