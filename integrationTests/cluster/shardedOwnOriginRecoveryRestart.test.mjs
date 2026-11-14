// A sharded node restarted after an OS restart asks its peers for its own writes back (harper-pro#1364). Its
// same-shard co-owner holds its sharded rows, which the restarted node takes only from a snapshot copy, so the
// recovery pass leaves them out; sending them live closed the link on every reconnect (close 1011). Each start
// names its boot (`HARPER_TEST_BOOT_ID`), so the restart always opens a recovery epoch.
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { appendFile, cp, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const fixture = join(import.meta.dirname, 'fixture-sharding-quarantine');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

const startOptions = (hostname, shard, bootId) => ({
	env: { HARPER_TEST_BOOT_ID: bootId },
	config: {
		threads: { count: 1 },
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, level: 'warn' },
		replication: { threads: 0, securePort: hostname + ':9933', databases: '*', shard, shards: [0, 1] },
		operationsApi: { network: { domainSocket: false } },
	},
});

suite('a sharded node restarted after an OS restart', { timeout: 600_000, skip: isLMDB && 'RocksDB only' }, (ctx) => {
	const nodes = [];
	const contexts = [];
	const auth = (node) => 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64');
	async function localRows(node, signal) {
		const response = await fetch(`${node.httpURL}/OwnRows`, { headers: { Authorization: auth(node) }, signal });
		assert.equal(response.status, 200);
		return response.json();
	}
	async function put(node, id, body) {
		const response = await fetch(`${node.httpURL}/Rows/${id}`, {
			method: 'PUT',
			headers: { 'Authorization': auth(node), 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, body }),
			signal: AbortSignal.timeout(60_000),
		});
		assert.ok(response.status < 300, `${response.status} ${await response.text()}`);
	}
	function meshed(description) {
		return waitForCondition(
			async (signal) => {
				const statuses = await Promise.all(
					nodes.map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal }).catch(() => undefined))
				);
				return statuses.every(
					(status) =>
						status?.sharding?.data?.state === 'available' &&
						status.connections.filter((connection) =>
							connection.database_sockets.some((socket) => socket.database === 'data' && socket.connected)
						).length ===
							nodes.length - 1
				);
			},
			{ timeoutMs: 180_000, description }
		);
	}

	before(async () => {
		for (const shard of [0, 1, 1]) {
			const hostname = await getNextAvailableLoopbackAddress();
			const dataRootDir = await mkdtemp(
				join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'shard-restart-')
			);
			const context = { name: ctx.name, harper: { hostname, dataRootDir } };
			const component = join(dataRootDir, 'components', basename(fixture));
			await cp(fixture, component, { recursive: true });
			await writeFile(
				join(component, 'schema.graphql'),
				`type Rows @table @export @sharded(slots: 2) {
					id: ID @primaryKey
					body: String
				}`
			);
			await appendFile(
				join(component, 'resources.js'),
				`
export class OwnRows extends Resource {
 get() {
  return Array.from(tables.Rows.primaryStore.getRange({ start: true }), (entry) => ({ id: entry.key, body: entry.value?.body, flags: entry.metadataFlags }));
 }
}
`
			);
			await startHarper(context, startOptions(hostname, shard, 'sharded-restart-boot-1'));
			contexts.push({ context, shard });
			nodes.push(context.harper);
		}
		const [seed, ...peers] = nodes;
		const { operation_token: token } = await sendOperation(seed, {
			operation: 'create_authentication_tokens',
			authorization: seed.admin,
		});
		for (const peer of peers)
			await sendOperation(peer, {
				operation: 'add_node',
				hostname: seed.hostname,
				authorization: 'Bearer ' + token,
				rejectUnauthorized: false,
			});
		await meshed('the cluster to form');
	});
	after(() => stopAndTeardownNodes(nodes));

	test('reconnects to its co-owner, and the co-owner’s writes reach it', async () => {
		const [, writer, coOwner] = nodes;
		const ids = Array.from({ length: 8 }, (_, i) => `own-${i}`);
		for (const id of ids) await put(writer, id, id);
		// the co-owner stores the rows of its own shard: these are the writer's sharded rows it would return
		let owned;
		await waitForCondition(
			async (signal) => {
				const rows = await localRows(coOwner, signal);
				owned = ids.filter((id) => rows.some((row) => row.id === id && row.body === id && !(row.flags & 5)));
				return owned.length > 0;
			},
			{ timeoutMs: 60_000, description: 'the co-owner to store the writer’s rows of their shard' }
		);
		await stopNodeProcess(writer);
		const { context, shard } = contexts[1];
		context.harper = { hostname: writer.hostname, dataRootDir: writer.dataRootDir };
		await startHarper(context, startOptions(writer.hostname, shard, 'sharded-restart-boot-2'));
		nodes[1] = context.harper;
		await meshed('the cluster to reconnect after restarting the sharded writer');
		// a link that keeps closing is connected for a moment after each handshake, so a write must cross it
		const id = owned[0];
		await put(coOwner, id, 'from-co-owner');
		await waitForCondition(
			async (signal) =>
				(await localRows(nodes[1], signal)).some((row) => row.id === id && row.body === 'from-co-owner'),
			{ timeoutMs: 60_000, description: 'the co-owner’s write to reach the restarted writer' }
		);
	});
});
