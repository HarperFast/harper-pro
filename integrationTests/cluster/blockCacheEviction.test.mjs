/**
 * Integration test: replication must survive RocksDB `store.get()` returning a Promise.
 *
 * Background — the bug class this guards against:
 *   On RocksDB, `store.get(id)` returns a `MaybePromise`: the record SYNCHRONOUSLY when it is in the
 *   block cache / memtable, but a *Promise* on a cache miss that needs a disk read. (LMDB is always
 *   synchronous, so this is RocksDB-only.) Several replication paths read `hdb_nodes` with an un-awaited
 *   `primaryStore.get(...)` and consume the result synchronously (`?.replicates`, `?.url`, truthiness).
 *   While the row is cached `get()` is synchronous, so it works. Once the system database grows past the
 *   block cache — or immediately after a restart, when the cache is COLD — `get()` returns a Promise;
 *   `Promise?.replicates` is `undefined`, which silently disables replication / drops a node from
 *   cluster_status / never opens a retrieval connection. The fix is `getSync(...)` at those sites.
 *
 * Why this test reproduces it:
 *   - Each node runs RocksDB with a SMALL (but viable) block cache, so system-table blocks do not stay
 *     resident under churn. (A sub-MB cache makes RocksDB hang on open, so "small" here is ~32 MB, far
 *     below the default ~25%-of-RAM — the cold restart below is what makes the miss DETERMINISTIC.)
 *   - Every node is RESTARTED, giving a COLD block cache + empty memtable, so the first post-restart read
 *     of each `hdb_nodes` record is a guaranteed cache miss (a Promise from `get()`). The startup
 *     replication paths (ensureThisNode / shouldReplicateFromNode) run exactly in that window.
 *   - We then drive the procedures that depend on those synchronous reads — a rolling restart and a
 *     remove_node / add_node cycle — and assert replication stays healthy and converges.
 *
 * Pre-fix this fails: a post-restart cache miss makes shouldReplicateFromNode falsy (unsubscribe) and/or
 * flips `isFullyReplicating = false` ("Disabling replication"), so the post-restart write never converges.
 * Post-fix the synchronous reads return the real records regardless of cache state, so it converges.
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

// Small but viable RocksDB block cache: far below the default (~25% of RAM) so blocks are evicted under
// churn, yet large enough that opening Harper's databases does not hang (a sub-MB cache does). The cold
// restart is what makes the cache-miss deterministic; this keeps misses from being papered over by a
// warm cache. We deliberately do NOT shrink the WriteBufferManager — a tiny WBM with allowStall stalls
// the schema writes during startup.
const SMALL_ROCKS = { blockCacheSize: 32 * 1024 * 1024 };

// Some padded records so the data table spans multiple SST blocks (cache pressure). Convergence is
// checked via sentinel records, not a full count, so the exact number/pagination doesn't matter.
const SEED_RECORD_COUNT = 500;
const PADDING = 'x'.repeat(1024);

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

async function waitForRecord(node, id, { retries = 90, intervalMs = 1000 } = {}) {
	for (let i = 0; i < retries; i++) {
		const rows = await sendOperation(node, {
			operation: 'search_by_value',
			database: 'data',
			table: 'cache_evict_test',
			search_attribute: 'id',
			search_value: id,
			get_attributes: ['id', 'value'],
		}).catch(() => []);
		const found = (rows ?? [])[0];
		if (found) return found;
		await delay(intervalMs);
	}
	return null;
}

suite(
	'replication survives RocksDB get() cache-miss Promises (small block cache + restart)',
	{ timeout: 240000 },
	(ctx) => {
		before(async () => {
			const hostnameA = await getNextAvailableLoopbackAddress();
			const hostnameB = await getNextAvailableLoopbackAddress();

			const makeNodeCtx = (hostname) => ({ name: ctx.name, harper: { hostname } });

			// Plaintext replication of BOTH 'data' and 'system' so hdb_nodes replicates across the pair
			// (the system table is the one that falls out of the block cache).
			const nodeConfig = (hostname) => ({
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, console: true },
					replication: { port: hostname + ':9933', securePort: null, databases: ['data', 'system'] },
					storage: { engine: 'rocksdb', rocks: SMALL_ROCKS },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});

			const ctxA = makeNodeCtx(hostnameA);
			const ctxB = makeNodeCtx(hostnameB);
			await Promise.all([startHarper(ctxA, nodeConfig(hostnameA)), startHarper(ctxB, nodeConfig(hostnameB))]);
			ctx.nodeA = ctxA.harper;
			ctx.nodeB = ctxB.harper;

			// Seed table + data on A, ending with a sentinel we can wait on.
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
			records.push({ id: 'seed-sentinel', value: 'seeded', pad: PADDING });
			for (let i = 0; i < records.length; i += 250) {
				await sendOperation(ctx.nodeA, {
					operation: 'upsert',
					database: 'data',
					table: 'cache_evict_test',
					records: records.slice(i, i + 250),
				});
			}

			// B joins A as leader and full-copies the seed data.
			await sendOperation(ctx.nodeB, {
				operation: 'add_node',
				hostname: ctx.nodeA.hostname,
				rejectUnauthorized: false,
				isLeader: true,
				authorization: ctx.nodeA.admin,
			});

			const onB = await waitForRecord(ctx.nodeB, 'seed-sentinel');
			ok(onB, 'node B should have received the seeded data (sentinel) before we start perturbing it');
		});

		after(async () => {
			await Promise.all([
				ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
				ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
			]);
		});

		test('cold-cache restart does not silently disable replication; cluster reconverges', async () => {
			const { nodeA, nodeB } = ctx;

			// Rolling restart -> COLD block cache on each node. The startup replication paths
			// (ensureThisNode / shouldReplicateFromNode / cluster bootstrap) now read hdb_nodes from a cold
			// cache, which is the exact get()->Promise condition this test guards.
			for (const node of [nodeA, nodeB]) {
				await sendOperation(node, { operation: 'restart' }).catch(() => {});
				await pollHealth(node);
			}

			// (1) Direct catch for the silent-disable bug: a cold-cache Promise self-row logs
			// "Disabling replication". It must not appear.
			for (const node of [nodeA, nodeB]) {
				const log = await readLog(node);
				ok(
					!/Disabling replication/.test(log),
					`node ${node.hostname} logged "Disabling replication" after a cold-cache restart (get() Promise self-row)`
				);
			}

			// (2) cluster_status must still report this node's own record after the cold restart
			// (clusterStatus reads hdb_nodes for the self record; a Promise there omits node_name).
			for (const node of [nodeA, nodeB]) {
				const status = await pollHealth(node);
				ok(status.node_name, `cluster_status on ${node.hostname} is missing node_name after restart`);
			}

			// (3) A write made AFTER the cold restart must converge to B. If a cold-cache get() Promise
			// silently disabled replication / unsubscribed the peer, this never arrives.
			await sendOperation(nodeA, {
				operation: 'upsert',
				database: 'data',
				table: 'cache_evict_test',
				records: [{ id: 'post-restart-1', value: 'after-cold-cache', pad: PADDING }],
			});
			const found = await waitForRecord(nodeB, 'post-restart-1');
			ok(found, 'post-restart write did not converge to node B (replication silently disabled?)');
			equal(found.value, 'after-cold-cache', 'wrong value converged to node B');
		});

		test('remove_node + add_node cycle under a small block cache reconverges', async () => {
			const { nodeA, nodeB } = ctx;

			// Remove B's subscription to A, then re-add it. add_node / ensureNode /
			// getRetrievalConnectionByName all read hdb_nodes via point lookup.
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
			const found = await waitForRecord(nodeB, 'readd-1');
			ok(found, 'write after remove_node/add_node did not converge to node B');
			equal(found.value, 'after-readd', 'wrong value converged to node B after re-add');

			const log = await readLog(nodeB);
			ok(!/Disabling replication/.test(log), 'node B logged "Disabling replication" during remove/add cycle');
		});
	}
);
