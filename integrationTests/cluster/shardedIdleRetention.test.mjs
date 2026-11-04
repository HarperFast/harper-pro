/**
 * A sharded database idle past auditRetention resumes after a restart, and an owner's refusal of a copy it
 * cannot accept is reported once and backed off (harper-pro#1231).
 *
 * Two nodes, one per shard, `@sharded(slots: 2)` on `data`. After writes, both sit idle past a retention of
 * seconds and restart. Before harper-pro#1229 each sender forced a base copy on the other's old resume
 * point; the receiver owns slots, so it refused with 1011 ("Owned sharding slots require a complete
 * co-owner or backup restore") and reconnected every few seconds forever, logging only at debug.
 *
 * Then node 0 restarts with its retention copy forced (HARPER_TEST_FORCE_RETENTION_COPY_DATABASES): node 1
 * must log the refusal once, show it as `stuckCopy` in cluster_status, and hold its reconnects.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHarper, killHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, waitForCondition, logMark, readLogSince } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');
const FIXTURE = join(TEST_DIR, 'fixture-sharding-quarantine');

const RETENTION_S = 20;
const IDLE_MS = (RETENTION_S + 25) * 1000;
const FORCED_COPY = 'forcing a bounded base-copy resync';
const REFUSED = 'refused a copy this node cannot accept';
// with slots: 2, shard 1 owns ids '0' and '2', shard 0 owns '1' and '3' (shardingBootstrap.test.mjs)
const OWNED_BY = [
	['1', '3'],
	['0', '2'],
];

suite('sharded database idle past retention', { timeout: 900_000 }, (ctx) => {
	const nodes = [];

	const options = (node, shard, env = {}) => ({
		env: { HARPER_NO_FLUSH_ON_EXIT: true, ...env },
		config: {
			threads: { count: 1 },
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, level: 'debug', auditRetention: RETENTION_S },
			replication: {
				failover: true,
				securePort: node.hostname + ':9933',
				databases: '*',
				shard,
				shards: [0, 1],
			},
			operationsApi: { network: { domainSocket: false } },
		},
	});

	async function start(i, env) {
		const node = nodes[i];
		const started = (await startHarper({ name: ctx.name, harper: node }, options(node, i, env))).harper;
		return Object.assign(node, started);
	}

	async function request(node, path, init = {}) {
		return fetch(`${node.httpURL}/${path}`, {
			...init,
			headers: {
				'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
				'Content-Type': 'application/json',
			},
			signal: init.signal ?? AbortSignal.timeout(30_000),
		});
	}

	const put = async (node, id, body) => {
		const response = await request(node, `Rows/${id}`, { method: 'PUT', body: JSON.stringify({ id, body }) });
		ok(response.status >= 200 && response.status < 300, `${response.status} ${await response.text()}`);
	};

	const holds = async (node, id, body, signal) => {
		const rows = await sendOperation(
			node,
			{
				operation: 'search_by_id',
				database: 'data',
				table: 'Rows',
				ids: [id],
				get_attributes: ['*'],
				replicateFrom: false,
			},
			{ signal }
		);
		return rows.length === 1 && rows[0].body === body;
	};

	const ownerHolds = (owner, id, body) =>
		waitForCondition((signal) => holds(nodes[owner], id, body, signal), {
			timeoutMs: 90_000,
			description: `node ${owner} to hold ${id}=${body}`,
		});

	const socketTo = async (node, peer, signal) => {
		const status = await sendOperation(node, { operation: 'cluster_status' }, { signal });
		return status.connections
			?.find((connection) => connection.name === peer.hostname)
			?.database_sockets?.find((socket) => socket.database === 'data');
	};

	const linesSince = async (node, mark, text) =>
		(await readLogSince(node, mark)).split('\n').filter((line) => line.includes(text));

	async function ready() {
		await waitForCondition(
			async (signal) => {
				const statuses = await Promise.all(
					nodes.map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal }))
				);
				return statuses.every((status) => status.sharding?.data?.recovery?.phase === 'ready');
			},
			{ timeoutMs: 120_000, description: 'both owners ready' }
		);
	}

	before(async () => {
		for (let i = 0; i < 2; i++) {
			const hostname = await getNextAvailableLoopbackAddress();
			const dataRootDir = await mkdtemp(
				join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'shard-idle-')
			);
			nodes[i] = { hostname, dataRootDir };
			const component = join(dataRootDir, 'components', basename(FIXTURE));
			await cp(FIXTURE, component, { recursive: true });
			await writeFile(
				join(component, 'schema.graphql'),
				`type Rows @table @export @sharded(slots: 2) {
					id: ID @primaryKey
					body: String
				}`
			);
			await start(i);
		}
		const { operation_token } = await sendOperation(nodes[0], {
			operation: 'create_authentication_tokens',
			authorization: nodes[0].admin,
		});
		await sendOperation(nodes[1], {
			operation: 'add_node',
			hostname: nodes[0].hostname,
			authorization: 'Bearer ' + operation_token,
			rejectUnauthorized: false,
		});
		await ready();
		for (const owner of [0, 1]) for (const id of OWNED_BY[owner]) await put(nodes[owner], id, 'before-idle');
		for (const owner of [0, 1]) for (const id of OWNED_BY[owner]) await ownerHolds(owner, id, 'before-idle');
	});

	after(async () => {
		try {
			await stopAndTeardownNodes(nodes);
		} finally {
			// the data roots are this suite's own, not the harness's
			await Promise.all(
				nodes.map((node) => node?.dataRootDir && rm(node.dataRootDir, { recursive: true, force: true }))
			);
		}
	});

	test('both nodes restart after an idle interval longer than retention and replicate with no base copy', async () => {
		await delay(IDLE_MS);
		const marks = await Promise.all(nodes.map(logMark));
		for (const node of nodes) await killHarper({ harper: node });
		for (let i = 0; i < 2; i++) await start(i);
		await ready();
		await waitForCondition(
			async (signal) =>
				(await socketTo(nodes[0], nodes[1], signal))?.connected &&
				(await socketTo(nodes[1], nodes[0], signal))?.connected,
			{ timeoutMs: 90_000, description: 'both data legs connected' }
		);
		await delay(5000);
		for (const [i, node] of nodes.entries()) {
			const forced = await linesSince(node, marks[i], FORCED_COPY);
			equal(forced.length, 0, `node ${i} forced a copy:\n${forced.join('\n')}`);
			ok(!(await socketTo(node, nodes[i ^ 1]))?.stuckCopy, `node ${i} reports a stuck copy`);
		}
		await put(nodes[0], OWNED_BY[1][0], 'after-idle');
		await ownerHolds(1, OWNED_BY[1][0], 'after-idle');
	});

	test("an owner's refusal of a forced copy is logged once, reported, and backed off", async () => {
		const marks = await Promise.all(nodes.map(logMark));
		await killHarper({ harper: nodes[0] });
		await start(0, { HARPER_TEST_FORCE_RETENTION_COPY_DATABASES: 'data' });
		const stuck = await waitForCondition(
			async (signal) => {
				const socket = await socketTo(nodes[1], nodes[0], signal);
				return socket?.stuckCopy?.state === 'refused' && socket.stuckCopy.retryAt && socket.stuckCopy;
			},
			{ timeoutMs: 120_000, description: 'node 1 to report the refused copy' }
		);
		equal(stuck.reason, 'Owned sharding slots require a complete co-owner or backup restore');
		ok(Date.parse(stuck.retryAt) > Date.now(), `retries at ${stuck.retryAt}`);
		await delay(45_000);
		const refusals = await linesSince(nodes[1], marks[1], REFUSED);
		equal(refusals.length, 1, `one refusal line:\n${refusals.join('\n')}`);
		// the hold floor is 60 s: the sender forced the copy at most twice in that window, not every few seconds
		const forced = await linesSince(nodes[0], marks[0], FORCED_COPY);
		ok(forced.length >= 1 && forced.length <= 2, `node 0 forced ${forced.length} copies:\n${forced.join('\n')}`);
	});
});
