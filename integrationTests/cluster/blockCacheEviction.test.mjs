/**
 * Integration test: replication must survive RocksDB `store.get()` returning a Promise.
 *
 * Background — the bug class this guards against:
 *   On RocksDB, `store.get(id)` returns a `MaybePromise`: the record SYNCHRONOUSLY when it is in the
 *   block cache / memtable, but a *Promise* on a cache miss that needs a disk read. (LMDB is always
 *   synchronous, so this is RocksDB-only.) Several replication paths read `hdb_nodes` (and other system
 *   records) with an un-awaited `primaryStore.get(...)` and then consume the result synchronously
 *   (`?.replicates`, `?.url`, truthiness checks). While the system database is small the row stays in
 *   cache and `get()` is synchronous, so it works. Once the system database grows past the block cache —
 *   or immediately after a restart, when the cache is COLD — `get()` returns a Promise; `Promise?.replicates`
 *   is `undefined`, which silently disables replication / drops a node from cluster_status / never opens a
 *   retrieval connection. The fix is to use the synchronous `getSync(...)` at those sites.
 *
 * Why this test reproduces it:
 *   1. `storage.rocks.blockCacheSize` is set very small, so system-table blocks do not stay resident.
 *   2. Every node is RESTARTED, which gives a COLD block cache + empty memtable — so the first
 *      post-restart read of each `hdb_nodes` record is a guaranteed cache miss (a Promise from `get()`).
 *   3. We then drive the procedures that depend on those synchronous system-table reads: a rolling
 *      restart, a `cluster_status` query, and a `remove_node` / `add_node` cycle — and assert replication
 *      stays healthy and converges.
 *
 * Pre-fix this fails: a post-restart cache miss flips `isFullyReplicating = false` ("Disabling
 * replication" log) and/or drops the peer, so the post-restart write never converges. Post-fix the
 * synchronous reads return the real records regardless of cache state, so the cluster converges.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

// Tiny RocksDB memory budget: a 1 MB block cache and 512 KB WriteBufferManager are far below the
// cluster's working set, so blocks (including system-table blocks) are evicted under any churn. The
// restart below is what makes the cache-miss DETERMINISTIC; this just keeps misses from being papered
// over by a warm cache between operations.
const TINY_ROCKS = {
	blockCacheSize: 1024 * 1024,
	writeBufferManagerSize: 512 * 1024,
	writeBufferManagerCostToCache: true,
};

// Enough moderately-sized records to push the data table well past the 1 MB block cache, so a system
// row cannot ride along in a warm cache after we start reading the data table.
const SEED_RECORD_COUNT = 3000;
const PADDING = 'x'.repeat(512);

async function pollHealth(node, { retries = 60, intervalMs = 2000 } = {}) {
	for (let i = 0; i < retries; i++) {
		try {
			const status = await sendOperation(node, { operation: 'cluster_status' });
			if (status) return status;
		} catch {
			/* transient during restart */
		}
		await delay(intervalMs);
	}
	throw new Error(`node ${node.hostname} did not come healthy in time`);
}

async function countRecords(node) {
	const result = await sendOperation(node, {
		operation: 'search_by_value',
		database: 'data',
		table: 'cache_evict_test',
		search_attribute: 'id',
		search_value: '*',
		get_attributes: ['id'],
	}).catch(() => []);
	return (result ?? []).length;
}

async function waitForCount(node, expected, { retries = 120, intervalMs = 1000 } = {}) {
	let last = 0;
	for (let i = 0; i < retries; i++) {
		last = await countRecords(node);
		if (last >= expected) return last;
		await delay(intervalMs);
	}
	return last;
}

suite(
	'replication survives RocksDB get() cache-miss Promises (small block cache + restart)',
	{ timeout: 300000 },
	(ctx) => {
		before(async () => {
			const hostnameA = await getNextAvailableLoopbackAddress();
			const hostnameB = await getNextAvailableLoopbackAddress();
			const hostnameC = await getNextAvailableLoopbackAddress();

			const makeNodeCtx = (hostname) => ({ name: ctx.name, harper: { hostname } });

			// Plaintext replication of BOTH 'data' and 'system' so hdb_nodes replicates across the mesh
			// (the system table grows on every node, which is the table that falls out of the block cache).
			const nodeConfig = (hostname) => ({
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, console: true },
					replication: { port: hostname + ':9933', securePort: null, databases: ['data', 'system'] },
					storage: { engine: 'rocksdb', rocks: TINY_ROCKS },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});

			const ctxA = makeNodeCtx(hostnameA);
			const ctxB = makeNodeCtx(hostnameB);
			const ctxC = makeNodeCtx(hostnameC);

			await Promise.all([
				startHarper(ctxA, nodeConfig(hostnameA)),
				startHarper(ctxB, nodeConfig(hostnameB)),
				startHarper(ctxC, nodeConfig(hostnameC)),
			]);

			ctx.nodeA = ctxA.harper;
			ctx.nodeB = ctxB.harper;
			ctx.nodeC = ctxC.harper;

			// Seed table + data on A.
			await sendOperation(ctx.nodeA, {
				operation: 'create_table',
				database: 'data',
				table: 'cache_evict_test',
				primary_key: 'id',
			});
			const records = Array.from({ length: SEED_RECORD_COUNT }, (_, i) => ({
				id: `seed-${i}`,
				value: `v${i}`,
				pad: PADDING,
			}));
			// chunk the upsert so a single payload stays reasonable
			for (let i = 0; i < records.length; i += 500) {
				await sendOperation(ctx.nodeA, {
					operation: 'upsert',
					database: 'data',
					table: 'cache_evict_test',
					records: records.slice(i, i + 500),
				});
			}

			// B and C join A as leader (star topology); both full-copy the seed data.
			for (const node of [ctx.nodeB, ctx.nodeC]) {
				await sendOperation(node, {
					operation: 'add_node',
					hostname: ctx.nodeA.hostname,
					rejectUnauthorized: false,
					isLeader: true,
					authorization: ctx.nodeA.admin,
				});
			}

			// Confirm the cluster converged before we start perturbing it.
			ctx.seeded = SEED_RECORD_COUNT;
			const onB = await waitForCount(ctx.nodeB, SEED_RECORD_COUNT);
			const onC = await waitForCount(ctx.nodeC, SEED_RECORD_COUNT);
			ok(onB >= SEED_RECORD_COUNT, `node B should have ${SEED_RECORD_COUNT} seed records before restart, got ${onB}`);
			ok(onC >= SEED_RECORD_COUNT, `node C should have ${SEED_RECORD_COUNT} seed records before restart, got ${onC}`);
		});

		after(async () => {
			await Promise.all([
				ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
				ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
				ctx.nodeC && teardownHarper({ harper: ctx.nodeC }),
			]);
		});

		test('cold-cache restart does not silently disable replication; cluster reconverges', async () => {
			const { nodeA, nodeB, nodeC } = ctx;

			// Rolling restart of every node -> COLD block cache on each. The startup replication paths
			// (ensureThisNode / shouldReplicateFromNode / cluster bootstrap) now read hdb_nodes from a cold
			// cache, so those reads are the exact get()->Promise condition this guards.
			for (const node of [nodeA, nodeB, nodeC]) {
				await sendOperation(node, { operation: 'restart' }).catch(() => {});
				await pollHealth(node);
			}

			// (1) Direct catch for the silent-disable bug (subscriptionManager: `!selfNodeRow?.replicates`):
			// a Promise self-row would log "Disabling replication" on a cold cache. It must not appear.
			for (const node of [nodeA, nodeB, nodeC]) {
				const log = await readLog(node);
				ok(
					!/Disabling replication/.test(log),
					`node ${node.hostname} logged "Disabling replication" after a cold-cache restart (get() Promise self-row)`
				);
			}

			// (2) cluster_status must still report this node's own shard/url (clusterStatus reads hdb_nodes
			// for the self record; a Promise there silently omits url/node_name).
			for (const node of [nodeA, nodeB, nodeC]) {
				const status = await pollHealth(node);
				ok(status.node_name, `cluster_status on ${node.hostname} is missing node_name after restart`);
			}

			// (3) A write made AFTER the cold restart must converge to B and C. If a cold-cache get() Promise
			// silently disabled replication on any node, this never arrives.
			await sendOperation(nodeA, {
				operation: 'upsert',
				database: 'data',
				table: 'cache_evict_test',
				records: [{ id: 'post-restart-1', value: 'after-cold-cache', pad: PADDING }],
			});
			for (const node of [nodeB, nodeC]) {
				let found = null;
				for (let i = 0; i < 90 && !found; i++) {
					await delay(1000);
					const rows = await sendOperation(node, {
						operation: 'search_by_value',
						database: 'data',
						table: 'cache_evict_test',
						search_attribute: 'id',
						search_value: 'post-restart-1',
						get_attributes: ['id', 'value'],
					}).catch(() => []);
					found = (rows ?? [])[0] ?? null;
				}
				ok(found, `post-restart write did not converge to ${node.hostname} (replication silently disabled?)`);
				equal(found.value, 'after-cold-cache', `wrong value converged to ${node.hostname}`);
			}
		});

		test('remove_node + add_node cycle under a small block cache reconverges', async () => {
			const { nodeA, nodeB } = ctx;

			// Remove B's subscription to A, then re-add it. add_node/ensureNode/getRetrievalConnectionByName
			// all read hdb_nodes via point lookup; with the tiny cache + the churn above those reads can miss.
			await sendOperation(nodeB, { operation: 'remove_node', hostname: nodeA.hostname }).catch(() => {});
			await delay(2000);
			await sendOperation(nodeB, {
				operation: 'add_node',
				hostname: nodeA.hostname,
				rejectUnauthorized: false,
				isLeader: true,
				authorization: nodeA.admin,
			});

			// A new write on A after the re-add must reach B (a missed retrieval-connection lookup would
			// silently never re-establish the subscription).
			await sendOperation(nodeA, {
				operation: 'upsert',
				database: 'data',
				table: 'cache_evict_test',
				records: [{ id: 'readd-1', value: 'after-readd', pad: PADDING }],
			});

			let found = null;
			for (let i = 0; i < 90 && !found; i++) {
				await delay(1000);
				const rows = await sendOperation(nodeB, {
					operation: 'search_by_value',
					database: 'data',
					table: 'cache_evict_test',
					search_attribute: 'id',
					search_value: 'readd-1',
					get_attributes: ['id', 'value'],
				}).catch(() => []);
				found = (rows ?? [])[0] ?? null;
			}
			ok(found, 'write after remove_node/add_node did not converge to node B');
			equal(found.value, 'after-readd', 'wrong value converged to node B after re-add');

			// No node should have silently disabled replication during the membership churn.
			const log = await readLog(nodeB);
			ok(!/Disabling replication/.test(log), 'node B logged "Disabling replication" during remove/add cycle');
		});
	}
);
