/** A, B: shard 0; C: shard 1; shards [0, 1]; one sharded table (harper-pro#1318, #1321). */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	sendOperation,
	postOperation,
	stopAndTeardownNodes,
	waitForCondition,
	logMark,
	readLogSince,
} from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const fixture = join(import.meta.dirname, 'fixture-sharding-quarantine');
const SHARDS = [0, 0, 1];
const MISMATCH = 'local shard membership disagrees with replication.shard';
// a reaction to an hdb_nodes change lands within this window on loopback
const SETTLE_MS = 3000;

suite('Node membership follows hdb_nodes and replication.shard', { timeout: 600_000 }, (ctx) => {
	const nodes = [];
	const status = (node, signal) => sendOperation(node, { operation: 'cluster_status' }, { signal });
	const insert = (node, id) =>
		postOperation(
			node,
			{ operation: 'insert', database: 'data', table: 'Rows', records: [{ id, body: id }] },
			{ signal: AbortSignal.timeout(15_000) }
		);
	// a replication socket closing on a worker thread; operation sockets live on the main thread
	const REPLICATION_CLOSE = /\[http\/\d+\] \[debug\] \[replication\]: \S+ \d+ closed \d+/;
	const REPLICATION_CONNECT = /Connecting to wss?:\/\//;
	// bootstrap keeps closing and retrying connections for a while after every owner reports ready
	async function waitForQuietConnections() {
		const deadline = Date.now() + 120_000;
		while (true) {
			if (Date.now() > deadline) assert.fail('replication connections never settled after bootstrap');
			const statuses = await Promise.all(nodes.map((node) => status(node, AbortSignal.timeout(10_000))));
			const allConnected = statuses.every(
				(entry) =>
					entry.connections.length === 2 &&
					entry.connections.every((peer) => peer.database_sockets.every((socket) => socket.connected))
			);
			if (!allConnected) {
				await delay(1000);
				continue;
			}
			const marks = await Promise.all(nodes.map(logMark));
			await delay(SETTLE_MS * 2);
			const logs = await Promise.all(nodes.map((node, i) => readLogSince(node, marks[i])));
			if (!logs.some((log) => REPLICATION_CONNECT.test(log) || REPLICATION_CLOSE.test(log))) return;
		}
	}
	async function assertNoReconnect(marks, step) {
		await delay(SETTLE_MS);
		for (const [i, node] of nodes.entries()) {
			const log = await readLogSince(node, marks[i]);
			assert.doesNotMatch(log, REPLICATION_CLOSE, `${step}: node ${i} closed no replication connection`);
			assert.doesNotMatch(log, REPLICATION_CONNECT, `${step}: node ${i} opened no replication connection`);
		}
	}
	async function assertNoUnsubscribe(marks, step) {
		for (const [i, node] of nodes.entries()) {
			const log = await readLogSince(node, marks[i]);
			assert.doesNotMatch(log, /Node was deleted, unsubscribing/, `${step}: node ${i} unsubscribed from no peer`);
		}
	}

	before(async () => {
		for (const shard of SHARDS) {
			const hostname = await getNextAvailableLoopbackAddress();
			const dataRootDir = await mkdtemp(
				join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'membership-')
			);
			const component = join(dataRootDir, 'components', basename(fixture));
			await cp(fixture, component, { recursive: true });
			await writeFile(
				join(component, 'schema.graphql'),
				'type Rows @table @export @sharded(slots: 2) {\n\tid: ID @primaryKey\n\tbody: String\n}\n'
			);
			const context = { name: ctx.name, harper: { hostname, dataRootDir } };
			await startHarper(context, {
				config: {
					threads: { count: 1 },
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, level: 'debug' },
					replication: { securePort: hostname + ':9933', databases: '*', shard, shards: [0, 1] },
					operationsApi: { network: { domainSocket: false } },
				},
			});
			nodes.push(context.harper);
		}
		const [a] = nodes;
		const { operation_token } = await sendOperation(a, {
			operation: 'create_authentication_tokens',
			authorization: a.admin,
		});
		for (const node of nodes.slice(1)) {
			await sendOperation(node, {
				operation: 'add_node',
				hostname: a.hostname,
				authorization: 'Bearer ' + operation_token,
				rejectUnauthorized: false,
			});
		}
		let statuses;
		try {
			await waitForCondition(
				async (signal) => {
					statuses = await Promise.all(nodes.map((node) => status(node, signal)));
					return statuses.every(
						(entry) => entry.sharding?.data?.recovery?.phase === 'ready' && entry.connections?.length === 2
					);
				},
				{ timeoutMs: 120_000, description: 'every owner is ready and connected to both peers' }
			);
		} catch (error) {
			console.log('Last statuses:', JSON.stringify(statuses?.map((entry) => entry.sharding)));
			throw error;
		}
	});
	after(() => stopAndTeardownNodes(nodes));

	test('a revoked_certificates update reaches every node and reopens no connection', async () => {
		const [a, b, c] = nodes;
		await waitForQuietConnections();
		const marks = await Promise.all(nodes.map(logMark));
		const response = await sendOperation(a, {
			operation: 'update_node',
			hostname: c.hostname,
			revoked_certificates: ['00deadbeef'],
		});
		assert.match(response.message, /^Successfully updated '[^']+'$/, 'patched locally, with no handshake warning');
		await waitForCondition(
			async (signal) => {
				const rows = await sendOperation(
					b,
					{
						operation: 'search_by_value',
						database: 'system',
						table: 'hdb_nodes',
						search_attribute: 'name',
						search_value: c.hostname,
						get_attributes: ['name', 'revoked_certificates'],
					},
					{ signal }
				);
				return rows[0]?.revoked_certificates?.includes('00deadbeef');
			},
			{ description: 'the revocation reaches node B' }
		);
		await assertNoReconnect(marks, 'revoked_certificates update');
		await assertNoUnsubscribe(marks, 'revoked_certificates update');
	});

	test("update_node moves a peer's shard on every node without a restart, and the moved node reports held", async () => {
		const [a, b, c] = nodes;
		const marks = await Promise.all(nodes.map(logMark));
		await sendOperation(a, { operation: 'update_node', hostname: c.hostname, shard: 0 });
		await waitForCondition(
			async (signal) => {
				const entry = await status(b, signal);
				const peer = entry.connections.find((connection) => connection.name === c.hostname);
				const shard0 = entry.sharding.data.shards.find(({ shard }) => shard === 0);
				return (
					peer?.shard === 0 &&
					shard0?.owners.includes(c.hostname) &&
					!entry.sharding.data.nodesOwningNoSlots.includes(c.hostname)
				);
			},
			{ description: 'node B lists C under shard 0 in connections and in the shard summary' }
		);
		await waitForCondition(
			async (signal) => {
				const entry = (await status(c, signal)).sharding.data;
				return entry.state === 'held' && entry.blocked && entry.errors.includes(MISMATCH);
			},
			{ description: 'node C reports its row disagreeing with replication.shard' }
		);
		const refused = await insert(c, 'membership-held');
		assert.equal(refused.status, 503, 'write admission refuses while C is held: ' + JSON.stringify(refused.body));

		await sendOperation(a, { operation: 'update_node', hostname: c.hostname, shard: 1 });
		await waitForCondition(
			async (signal) => {
				const [fromB, fromC] = await Promise.all([status(b, signal), status(c, signal)]);
				const peer = fromB.connections.find((connection) => connection.name === c.hostname);
				const shard1 = fromB.sharding.data.shards.find(({ shard }) => shard === 1);
				return (
					peer?.shard === 1 && shard1?.owners.includes(c.hostname) && !fromC.sharding.data.errors.includes(MISMATCH)
				);
			},
			{ description: 'node B lists C under shard 1 again and C clears the error without a restart' }
		);
		const accepted = await insert(c, 'membership-restored');
		assert.equal(accepted.status, 200, 'C accepts writes again: ' + JSON.stringify(accepted.body));
		// shard is routing-relevant (sharding re-agrees on a membership change), so only a teardown is ruled out
		await assertNoUnsubscribe(marks, 'shard move and revert');
	});

	test("update_node refuses to move a node's own row off replication.shard", async () => {
		const c = nodes[2];
		const response = await postOperation(c, { operation: 'update_node', hostname: c.hostname, shard: 0 });
		assert.equal(response.status, 400, JSON.stringify(response.body));
		assert.match(response.body.error, /follows replication\.shard \(1\)/);
		const [row] = await sendOperation(c, {
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_nodes',
			search_attribute: 'name',
			search_value: c.hostname,
			get_attributes: ['name', 'shard'],
		});
		assert.equal(row.shard, 1);
	});
});
