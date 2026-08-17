/**
 * Integration test: replication recovers from a rolling restart (small RocksDB block cache).
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
 * What this test is (and is NOT):
 *   It is a SCENARIO test: a real rolling restart of a 2-node cluster on RocksDB with a small block
 *   cache, asserting the startup replication paths (ensureThisNode / shouldReplicateFromNode /
 *   cluster_status) bring the cluster back and a post-restart write converges.
 *
 *   It is NOT a deterministic regression guard for the `get()`-returns-a-Promise bug itself, despite
 *   the name. That guard is `unitTests/replication/selfNodeReplicates.test.mjs` and
 *   `unitTests/replication/readNodeRowSync.test.mjs`, which inject a Promise-returning `get()` directly
 *   and fail deterministically when the `getSync` call sites regress. This file cannot reliably
 *   reproduce the miss: replication startup scans the `hdb_nodes` table before these point reads run,
 *   which can warm the rows into the cache first. Verified by mutation — reverting `selfNodeReplicates`
 *   and `readNodeRowSync` to plain `get()` leaves this suite green while the two unit tests fail.
 *   Reproducing a genuine point-read miss here would need `hdb_nodes` grown past the block cache, which
 *   is what the field repro had and a 2-node test does not. Do not read a pass here as evidence that the
 *   MaybePromise sites are still correct — this suite is a real-world rolling-restart check on top of,
 *   not instead of, the unit tests above.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog, restartNode, stopNodeProcess, pollHealth } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

// Small but viable RocksDB block cache: far below the default (~25% of RAM) so blocks are evicted under
// churn rather than staying resident regardless of restart. Per the header above, the startup
// `hdb_nodes` scan can still warm the rows before the point reads in this suite run, so this does not
// guarantee a cache-miss Promise — it's sized this way anyway so a warm cache from a stale prior run
// isn't what's papering over a real miss. We deliberately do NOT shrink the WriteBufferManager — a tiny
// WBM with allowStall stalls the schema writes during startup.
const SMALL_ROCKS = { blockCacheSize: 32 * 1024 * 1024 };

// Some padded records so the data table spans multiple SST blocks (cache pressure). Convergence is
// checked via sentinel records, not a full count, so the exact number/pagination doesn't matter.
const SEED_RECORD_COUNT = 500;
const PADDING = 'x'.repeat(1024);

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

/**
 * Compact cluster_status summary appended to a convergence failure so CI reports say WHY the
 * record never arrived (peer subscribed but idle vs. peer missing entirely) without needing the
 * uploaded server logs.
 */
async function describeReplication(node) {
	try {
		const status = await sendOperation(node, { operation: 'cluster_status' });
		const connections = (status.connections ?? []).map((connection) => {
			const sockets = (connection.database_sockets ?? [])
				.map(
					(socket) =>
						`${socket.database}(connected=${socket.connected}, ${socket.lastReceivedStatus}, lastReceived=${socket.lastReceivedVersion ?? 'none'})`
				)
				.join(' ');
			return `${connection.name ?? connection.url}[${sockets || 'no sockets'}]`;
		});
		return ` — ${node.hostname} cluster_status: node_name=${status.node_name}, connections: ${connections.join(' ') || 'none'}`;
	} catch (err) {
		return ` — cluster_status on ${node.hostname} failed: ${err.message}`;
	}
}

suite(
	'replication recovers from a rolling restart (small block cache, cold-cache reconnect)',
	// Sized above the test BODY's own aggregate retry budget (node:test charges only the body
	// against this, not before()/after()), not just its typical runtime (~5s): 2x restartNode
	// 60s + pollHealth 120s, then 2x pollHealth 120s, then waitForRecord 10s + 90s — ~700s if
	// every retry loop actually exhausts its count. If that sum exceeds this timeout, a
	// genuinely slow-but-working CI runner hits the suite timeout before any individual
	// helper's own (more specific) message fires — and node:test abandons the body in place
	// rather than aborting it, so `after()` runs concurrently with an in-flight
	// restartNode/pollHealth and can miss killing the process that comes up after it reads a
	// (momentarily absent) pid file, leaking a live Harper and its ports into later CI jobs.
	// NOTE: the ~700s figure assumes each retry fails fast — `sendOperation` has no per-request
	// timeout, so a node that accepts a connection but never answers stretches a single retry
	// to undici's own (much longer) timeout instead of this suite's. This value reduces the
	// race's probability; it does not close it.
	{ timeout: 1200000 },
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
			// Record each node as soon as its own start resolves (rather than after Promise.all settles) so
			// that if one start fails, the other's already-running process is still recorded and gets torn
			// down instead of leaked.
			await Promise.all([
				startHarper(ctxA, nodeConfig(hostnameA)).then(() => {
					ctx.nodeA = ctxA.harper;
				}),
				startHarper(ctxB, nodeConfig(hostnameB)).then(() => {
					ctx.nodeB = ctxB.harper;
				}),
			]);

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
			// Both nodes are restarted by the test, so teardownHarper's spawned-child handle is stale;
			// stop the process each node is actually running first or it outlives the suite.
			await Promise.all(
				[ctx.nodeA, ctx.nodeB].filter(Boolean).map(async (node) => {
					try {
						await stopNodeProcess(node);
					} catch (err) {
						console.error(`Failed to stop node process for ${node.hostname}:`, err);
					}
					await teardownHarper({ harper: node });
				})
			);
		});

		test('cold-cache restart does not silently disable replication; cluster reconverges', async () => {
			const { nodeA, nodeB } = ctx;

			// Rolling restart -> COLD block cache on each node. The startup replication paths
			// (ensureThisNode / shouldReplicateFromNode / cluster bootstrap) now read hdb_nodes from a cold
			// cache — though per the header above, the preceding hdb_nodes scan warms it before these
			// point reads run, so this does not reproduce a genuine cache-miss Promise.
			//
			// restartNode waits for a genuinely new process (pid change) rather than for health alone:
			// `restart` keeps answering the operations socket from the OUTGOING process for a moment, so
			// polling health only would let every step below run against a node that never restarted —
			// no cold cache, and the post-restart write landing in the shutdown window instead.
			for (const node of [nodeA, nodeB]) {
				await restartNode(node);
				await pollHealth(node);
			}

			// (1) Whatever the cause, a node that decides it should stop replicating logs
			// "Disabling replication". It must not appear after a routine restart.
			for (const node of [nodeA, nodeB]) {
				const log = await readLog(node);
				ok(
					!/Disabling replication/.test(log),
					`node ${node.hostname} logged "Disabling replication" after a routine cold-cache restart`
				);
			}

			// (2) cluster_status must still report this node's own record after the cold restart.
			for (const node of [nodeA, nodeB]) {
				const status = await pollHealth(node);
				ok(status.node_name, `cluster_status on ${node.hostname} is missing node_name after restart`);
			}

			// (3) A write made AFTER the cold restart must converge to B. If the restart left
			// replication silently disabled / the peer unsubscribed, this never arrives.
			await sendOperation(nodeA, {
				operation: 'upsert',
				database: 'data',
				table: 'cache_evict_test',
				records: [{ id: 'post-restart-1', value: 'after-cold-cache', pad: PADDING }],
			});
			// The write must be readable on its own node first, so a convergence failure below is
			// unambiguously a replication failure and not a write that never landed on A.
			const onA = await waitForRecord(nodeA, 'post-restart-1', { retries: 10 });
			ok(onA, 'post-restart write is not readable on node A itself — the write, not replication, was lost');

			const found = await waitForRecord(nodeB, 'post-restart-1');
			if (!found) {
				ok(
					false,
					`post-restart write did not converge to node B (replication silently disabled?)${await describeReplication(nodeB)}`
				);
			}
			equal(found.value, 'after-cold-cache', 'wrong value converged to node B');
		});

		// NOTE: a dedicated remove_node→add_node cycle test was dropped here. Removing a node's *leader*
		// leaves it with a null self-record so it (correctly) disables replication and does not re-converge
		// within the window — a remove_node re-subscription behavior orthogonal to the rolling-restart
		// scenario this suite exercises (ensureThisNode / shouldReplicateFromNode / cluster_status on a
		// cold cache). add_node itself is covered by the `before` hook and by
		// replicationReconnect.test.mjs / replicationTopology.test.mjs.
	}
);
