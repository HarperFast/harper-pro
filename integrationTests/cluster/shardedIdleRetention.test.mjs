/**
 * A sharded database idle past auditRetention resumes after a restart, and an owner's refusal of a copy it
 * cannot accept is reported once and backed off (harper-pro#1231, #1278).
 *
 * Two nodes, one per shard, `@sharded(slots: 2)` on `data`. Node 0 stops, node 1 writes once more, and both
 * sit idle past a retention of seconds, so node 0's start on node 1 is below node 1's purge bound. A sender
 * may not force a base copy on a node whose owned slots it cannot copy: the owner refuses it with 1011
 * ("Owned sharding slots require a complete co-owner or backup restore") and the leg never resumes. It
 * replays what it retained instead and warns once.
 *
 * Then node 0 restarts with its retention copy forced (HARPER_TEST_FORCE_RETENTION_COPY_DATABASES): node 1
 * must log the refusal once, show it as `stuckCopy` in cluster_status, and hold its reconnects, and a write
 * through node 0 for a key node 1 owns returns 503 rather than an acknowledgement no owner will see.
 * Node 1's next subscription, once the forcing has stopped, clears the refusal in the same node 0 process.
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
// the system database is not sharded, so it may take a copy (harper-pro#1308)
const DATA_DATABASE = 'database data';
const RESUMED_UNDER_PURGE = 'so replay continues from';
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
			logging: {
				colors: false,
				stdStreams: false,
				level: 'debug',
				auditRetention: RETENTION_S,
				// marks into hdb.log assume it is only appended to
				rotation: { enabled: false },
			},
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
	const forcedCopies = async (node, mark) =>
		(await linesSince(node, mark, FORCED_COPY)).filter((line) => line.includes(DATA_DATABASE));

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
		// node 0 misses node 1's last write, so once retention passes it, node 0's start is below node 1's purge bound
		await killHarper({ harper: nodes[0] });
		await put(nodes[1], OWNED_BY[1][1], 'while-0-down');
		await delay(IDLE_MS);
		await killHarper({ harper: nodes[1] });
		const marks = await Promise.all(nodes.map(logMark));
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
			const forced = await forcedCopies(node, marks[i]);
			equal(forced.length, 0, `node ${i} forced a copy:\n${forced.join('\n')}`);
			ok(!(await socketTo(node, nodes[i ^ 1]))?.stuckCopy, `node ${i} reports a stuck copy`);
		}
		const resumed = await linesSince(nodes[1], marks[1], RESUMED_UNDER_PURGE);
		ok(resumed.length >= 1, 'node 1 reports resuming node 0 under purged history');
		await put(nodes[0], OWNED_BY[1][0], 'after-idle');
		await ownerHolds(1, OWNED_BY[1][0], 'after-idle');
	});

	test("an owner's refusal of a forced copy is logged once, reported, and backed off", async () => {
		await killHarper({ harper: nodes[0] });
		const marks = await Promise.all(nodes.map(logMark));
		// forced only before node 1's first hold ends, so its retry replays (test 3)
		await start(0, {
			HARPER_TEST_FORCE_RETENTION_COPY_DATABASES: 'data',
			HARPER_TEST_FORCE_RETENTION_COPY_UNTIL: String(Date.now() + 45_000),
		});
		const stuck = await waitForCondition(
			async (signal) => {
				const socket = await socketTo(nodes[1], nodes[0], signal);
				return socket?.stuckCopy?.state === 'refused' && socket.stuckCopy.retryAt && socket.stuckCopy;
			},
			{ timeoutMs: 120_000, description: 'node 1 to report the refused copy' }
		);
		equal(stuck.reason, 'Owned sharding slots require a complete co-owner or backup restore');
		ok(Date.parse(stuck.retryAt) > Date.now(), `retries at ${stuck.retryAt}`);
		// a write node 1 would never receive fails instead of being acknowledged; node 0's own slots still take writes
		await ready();
		const refused = await request(nodes[0], `Rows/${OWNED_BY[1][1]}`, {
			method: 'PUT',
			body: JSON.stringify({ id: OWNED_BY[1][1], body: 'while-refused' }),
		});
		const refusal = await refused.text();
		equal(refused.status, 503, refusal);
		ok(refusal.includes('refusing replication from this node'), refusal);
		await put(nodes[0], OWNED_BY[0][0], 'while-refused');
		await delay(45_000);
		const refusals = await linesSince(nodes[1], marks[1], REFUSED);
		equal(refusals.length, 1, `one refusal line:\n${refusals.join('\n')}`);
		// the hold floor is 60 s: the sender forced the copy at most twice in that window, not every few seconds
		const forced = await forcedCopies(nodes[0], marks[0]);
		ok(forced.length >= 1 && forced.length <= 2, `node 0 forced ${forced.length} copies:\n${forced.join('\n')}`);
	});

	test("node 1's next subscription clears the refusal in the running node 0, and writes reach node 1 again", async () => {
		const held = await socketTo(nodes[1], nodes[0]);
		const holdMs = Math.max(0, (Date.parse(held?.stuckCopy?.retryAt) || 0) - Date.now());
		const accepted = await waitForCondition(
			async (signal) => {
				const response = await request(nodes[0], `Rows/${OWNED_BY[1][0]}`, {
					method: 'PUT',
					body: JSON.stringify({ id: OWNED_BY[1][0], body: 'after-refusal' }),
					signal,
				});
				await response.text();
				return response.status < 300;
			},
			{ timeoutMs: holdMs + 90_000, description: 'node 0 to accept a write for node 1 once node 1 resubscribes' }
		);
		ok(accepted);
		await ownerHolds(1, OWNED_BY[1][0], 'after-refusal');
		ok(await holds(nodes[1], OWNED_BY[1][1], 'while-0-down'), 'the refused write changed nothing on node 1');
	});
});
