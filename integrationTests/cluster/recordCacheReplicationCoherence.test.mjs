/**
 * Regression anchor: harper#410's record cache stays coherent across REPLICATION.
 *
 * Pins the record-cache × replication × invalidate interaction — the cluster-tier
 * seam that the single-node suite cannot reach. harper#410's per-worker
 * WeakLRUCache (on PrimaryRocksDatabase, verified via the shared RocksDB
 * VerificationTable) is confirmed coherent on a SINGLE node under multi-worker
 * load (update / delete / TTL-eviction / conditional-write / blob / null). The
 * seam left untested: when node A applies a write that REPLICATES to node B, does
 * B's *source-apply* path (core/resources/Table.ts `source.subscribe()` handler —
 * `_writeUpdate` / `_writeDelete` with `event.sourceApply = true`) invalidate B's
 * own local record cache the same way a direct local write does
 * (PrimaryRocksDatabase's putSync/removeSync call `this.#cache?.delete(id)`)?
 *
 * A stale entry here would surface as a cross-node ghost: node B serving a value
 * that node A has already overwritten or deleted.
 *
 * Design note on the oracle: `search_by_id` / REST point-GET both resolve through
 * `primaryStore.getEntry(id)` — the cached path under test. To avoid a circular
 * oracle (using the cached path to decide whether the cached path is stale), this
 * test establishes "B has genuinely applied the write" via `search_by_value` with
 * a wildcard, which resolves through `primaryStore.getRange()` — a method
 * PrimaryRocksDatabase does NOT route through `#cache` at all. That scan is the
 * ground truth; only once it shows the new value do we judge the cached
 * point-lookup path. That is the moment a sticky-cache defect shows up as a
 * mismatch, with replication lag ruled out.
 *
 * Complements cacheReplicationSource.test.mjs, which covers the unrelated
 * `sourcedFrom` / `replicationSource` origin-fetch cache (harper-pro#416), not the
 * harper#410 record cache exercised here.
 *
 * Originating QA scenario: QA-545.
 */

import { suite, test, before, after } from 'node:test';
import { equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const TABLE = 'qa545';
const DATABASE = 'data';

/** Raw operations POST that doesn't assert status, for connect-retry loops. */
async function rawOperation(node, operation) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	});
	return { status: response.status, body: await response.json() };
}

/** Bidirectionally connect nodeB to nodeA, waiting for live database sockets both ways. */
async function connectNodes(nodeA, nodeB) {
	let tokenResp;
	for (let i = 0; i < 20; i++) {
		const result = await rawOperation(nodeA, { operation: 'create_authentication_tokens', authorization: nodeA.admin });
		if (result.status === 200 && result.body.operation_token) {
			tokenResp = result.body;
			break;
		}
		await delay(300);
	}
	if (!tokenResp) throw new Error('Failed to obtain replication token from nodeA');

	for (let i = 0; i < 30; i++) {
		const result = await rawOperation(nodeB, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: nodeA.hostname,
			authorization: 'Bearer ' + tokenResp.operation_token,
		});
		if (result.status === 200) break;
		const errMsg = JSON.stringify(result.body);
		if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ECONNRESET') || errMsg.includes('connect ')) {
			await delay(500);
			continue;
		}
		throw new Error(`add_node failed (${result.status}): ${errMsg}`);
	}

	let retries = 0;
	while (true) {
		const [statusA, statusB] = await Promise.all([
			sendOperation(nodeA, { operation: 'cluster_status' }).catch(() => null),
			sendOperation(nodeB, { operation: 'cluster_status' }).catch(() => null),
		]);
		const aOk = statusA?.connections?.some?.((c) => c.database_sockets?.some?.((s) => s.connected));
		const bOk = statusB?.connections?.some?.((c) => c.database_sockets?.some?.((s) => s.connected));
		if (aOk && bOk) return;
		if (retries++ > 60) {
			throw new Error(
				`Timed out waiting for cluster to connect.\nA: ${JSON.stringify(statusA)}\nB: ${JSON.stringify(statusB)}`
			);
		}
		await delay(500);
	}
}

/**
 * GROUND TRUTH read: full-table scan via search_by_value (getRange path — bypasses
 * PrimaryRocksDatabase's #cache entirely). Returns the record for `id`, or undefined.
 */
async function scanRecord(node, id) {
	const results = await sendOperation(node, {
		operation: 'search_by_value',
		database: DATABASE,
		table: TABLE,
		search_attribute: 'id',
		search_value: '*',
		get_attributes: ['id', 'value', 'seq'],
	});
	return results.find((r) => r.id === id);
}

/**
 * CACHED read: point lookup via search_by_id — resolves through
 * primaryStore.getEntry(id), i.e. the WeakLRUCache path under test.
 */
async function pointGet(node, id) {
	const results = await sendOperation(node, {
		operation: 'search_by_id',
		database: DATABASE,
		table: TABLE,
		ids: [id],
		get_attributes: ['id', 'value', 'seq'],
	});
	return results[0];
}

/**
 * Poll the GROUND TRUTH scan on `node` until it reflects `expectedValue` for `id`
 * (or times out). This is how we know "the peer has genuinely applied the write" —
 * a scan never touches the point-GET cache, so it cannot itself be a stale-cache
 * false positive.
 */
async function waitForScanValue(node, id, expectedValue, opts = {}) {
	const timeoutMs = opts.timeoutMs ?? 30000;
	const pollMs = opts.pollMs ?? 200;
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await scanRecord(node, id);
		if (last?.value === expectedValue) return last;
		await delay(pollMs);
	}
	throw new Error(
		`Timed out waiting for ${node.hostname} scan of ${id} to show value=${expectedValue}; last seen: ${JSON.stringify(last)}`
	);
}

/**
 * Poll for deletion (ground truth = scan omits the id).
 */
async function waitForScanAbsence(node, id, opts = {}) {
	const timeoutMs = opts.timeoutMs ?? 30000;
	const pollMs = opts.pollMs ?? 200;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const rec = await scanRecord(node, id);
		if (!rec) return;
		await delay(pollMs);
	}
	throw new Error(`Timed out waiting for ${node.hostname} scan of ${id} to show deletion`);
}

suite('record cache (harper#410) coherence under replication', { timeout: 240000 }, (ctx) => {
	before(async () => {
		const [hostnameA, hostnameB] = await Promise.all([
			getNextAvailableLoopbackAddress(),
			getNextAvailableLoopbackAddress(),
		]);

		const commonConfig = (hostname) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true },
				replication: {
					securePort: hostname + ':9933',
					databases: ['data'],
				},
				storage: { engine: 'rocksdb' },
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});

		const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
		const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };

		await Promise.all([
			startHarper(ctxA, commonConfig(hostnameA)).then(() => {
				ctx.nodeA = ctxA.harper;
			}),
			startHarper(ctxB, commonConfig(hostnameB)).then(() => {
				ctx.nodeB = ctxB.harper;
			}),
		]);

		console.log('nodeA:', ctx.nodeA.hostname);
		console.log('nodeB:', ctx.nodeB.hostname);

		// Create the table on BOTH nodes before connecting (each node needs the 'data'
		// database + table declared locally — see fullyConnectedReplication.test.mjs).
		await Promise.all(
			[ctx.nodeA, ctx.nodeB].map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					database: DATABASE,
					table: TABLE,
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'value', type: 'String' },
						{ name: 'seq', type: 'Number' },
					],
				})
			)
		);

		await connectNodes(ctx.nodeA, ctx.nodeB);
		console.log('cluster connected');
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
		]);
	});

	test('(1) seed on A replicates to B', async () => {
		const { nodeA, nodeB } = ctx;
		await sendOperation(nodeA, {
			operation: 'upsert',
			database: DATABASE,
			table: TABLE,
			records: [
				{ id: 'rec-1', value: 'v0', seq: 0 },
				{ id: 'rec-2', value: 'v0', seq: 0 },
				{ id: 'rec-3', value: 'v0', seq: 0 },
			],
		});
		await waitForScanValue(nodeB, 'rec-1', 'v0');
		await waitForScanValue(nodeB, 'rec-2', 'v0');
		await waitForScanValue(nodeB, 'rec-3', 'v0');
	});

	test('(2) warm B point-GET cache, then update on A replicates and B point-GET reflects new value (not stale)', async () => {
		const { nodeA, nodeB } = ctx;

		// Warm nodeB's record cache for rec-1/rec-2/rec-3 via point-GET.
		for (const id of ['rec-1', 'rec-2', 'rec-3']) {
			const warmed = await pointGet(nodeB, id);
			equal(warmed?.value, 'v0', `warm read of ${id} on B should see v0`);
		}
		// Read again immediately to confirm these are now served from the cache path
		// (still v0 — sanity, not yet the interesting assertion).
		for (const id of ['rec-1', 'rec-2', 'rec-3']) {
			const cached = await pointGet(nodeB, id);
			equal(cached?.value, 'v0', `second warm read of ${id} on B should still see v0`);
		}

		// Update on A with a distinguishable new value.
		await sendOperation(nodeA, {
			operation: 'upsert',
			database: DATABASE,
			table: TABLE,
			records: [
				{ id: 'rec-1', value: 'v1', seq: 1 },
				{ id: 'rec-2', value: 'v1', seq: 1 },
				{ id: 'rec-3', value: 'v1', seq: 1 },
			],
		});

		for (const id of ['rec-1', 'rec-2', 'rec-3']) {
			// GROUND TRUTH: wait until B's scan (cache-independent) shows the new value.
			// Only past this point is B considered to have "genuinely applied" the write.
			await waitForScanValue(nodeB, id, 'v1');

			// NOW judge the cached point-GET path: this is where a sticky ghost would show up.
			const cached = await pointGet(nodeB, id);
			equal(
				cached?.value,
				'v1',
				`DEFECT CHECK: point-GET of ${id} on B after replicated apply must show v1, not a stale cached v0 (got ${JSON.stringify(cached)})`
			);
		}
	});

	test('(3) delete on A replicates; B must not serve a cached ghost of the deleted record', async () => {
		const { nodeA, nodeB } = ctx;

		// Re-warm B's cache with the current (v1) value before deleting.
		for (const id of ['rec-1', 'rec-2']) {
			const warmed = await pointGet(nodeB, id);
			equal(warmed?.value, 'v1');
		}

		await sendOperation(nodeA, { operation: 'delete', database: DATABASE, table: TABLE, ids: ['rec-1', 'rec-2'] });

		for (const id of ['rec-1', 'rec-2']) {
			await waitForScanAbsence(nodeB, id);
			const cached = await pointGet(nodeB, id);
			equal(
				cached,
				undefined,
				`DEFECT CHECK: point-GET of deleted ${id} on B must be gone, not a cached ghost (got ${JSON.stringify(cached)})`
			);
		}

		// Recreate on A -> must reappear on B, including via the (now-invalidated) cache path.
		await sendOperation(nodeA, {
			operation: 'upsert',
			database: DATABASE,
			table: TABLE,
			records: [
				{ id: 'rec-1', value: 'v2-recreated', seq: 2 },
				{ id: 'rec-2', value: 'v2-recreated', seq: 2 },
			],
		});
		for (const id of ['rec-1', 'rec-2']) {
			await waitForScanValue(nodeB, id, 'v2-recreated');
			const cached = await pointGet(nodeB, id);
			equal(
				cached?.value,
				'v2-recreated',
				`point-GET of recreated ${id} on B must show v2-recreated (got ${JSON.stringify(cached)})`
			);
		}
	});

	test('(4) bidirectional: write on B, warm+read on A', async () => {
		const { nodeA, nodeB } = ctx;

		await sendOperation(nodeB, {
			operation: 'upsert',
			database: DATABASE,
			table: TABLE,
			records: [{ id: 'rec-4', value: 'b-v0', seq: 0 }],
		});
		await waitForScanValue(nodeA, 'rec-4', 'b-v0');

		// Warm A's cache.
		const warmed = await pointGet(nodeA, 'rec-4');
		equal(warmed?.value, 'b-v0');

		// Update on B, verify A's point-GET reflects it after ground-truth catch-up.
		await sendOperation(nodeB, {
			operation: 'upsert',
			database: DATABASE,
			table: TABLE,
			records: [{ id: 'rec-4', value: 'b-v1', seq: 1 }],
		});
		await waitForScanValue(nodeA, 'rec-4', 'b-v1');
		const cached = await pointGet(nodeA, 'rec-4');
		equal(
			cached?.value,
			'b-v1',
			`DEFECT CHECK (reverse direction): point-GET of rec-4 on A after replicated apply must show b-v1 (got ${JSON.stringify(cached)})`
		);
	});

	test('(5) churn loop: repeated A-writes + immediate B cache-warm + B reads after ground-truth catch-up', async () => {
		const { nodeA, nodeB } = ctx;
		const id = 'rec-churn';
		const ITERATIONS = 15;

		await sendOperation(nodeA, {
			operation: 'upsert',
			database: DATABASE,
			table: TABLE,
			records: [{ id, value: 'churn-0', seq: 0 }],
		});
		await waitForScanValue(nodeB, id, 'churn-0');

		let staleGhosts = 0;
		let maxCatchupWindowMs = 0;
		for (let i = 1; i <= ITERATIONS; i++) {
			const newValue = `churn-${i}`;
			// Warm B's cache with the PREVIOUS value right before the update, to maximize
			// the odds of catching a stale entry if invalidation is broken.
			await pointGet(nodeB, id);

			const t0 = Date.now();
			await sendOperation(nodeA, {
				operation: 'upsert',
				database: DATABASE,
				table: TABLE,
				records: [{ id, value: newValue, seq: i }],
			});

			await waitForScanValue(nodeB, id, newValue, { timeoutMs: 15000, pollMs: 50 });
			const catchupMs = Date.now() - t0;
			if (catchupMs > maxCatchupWindowMs) maxCatchupWindowMs = catchupMs;

			// Immediately after ground-truth confirms B applied it, judge the cached path.
			const cached = await pointGet(nodeB, id);
			if (cached?.value !== newValue) {
				staleGhosts++;
				console.error(`STALE GHOST at iteration ${i}: expected ${newValue}, cached path returned`, cached);
			}
		}

		console.log(
			`Churn loop: ${ITERATIONS} iterations, max ground-truth catch-up window ${maxCatchupWindowMs}ms, stale ghosts: ${staleGhosts}`
		);
		equal(
			staleGhosts,
			0,
			`${staleGhosts}/${ITERATIONS} churn iterations served a stale cached ghost on B after replicated apply was confirmed via ground-truth scan`
		);
	});
});
