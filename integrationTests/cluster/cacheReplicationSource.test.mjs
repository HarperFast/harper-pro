/**
 * Cross-node integration test: `sourcedFrom` cache with `replicationSource: true`.
 *
 * Covers §5.5 Caching / Category 15 of the Harper v5 Integration Test Plan — the
 * sub-case that requires a live 2-node cluster and therefore cannot be exercised by
 * harper's single-node `integrationTests/server/caching.test.ts` or the unit suite
 * (tracked at HarperFast/harper#1189).
 *
 * Design
 * ──────
 * A mock HTTP "origin" server runs inside the test process and counts fetches
 * keyed by the calling Harper node's hostname. This lets us assert from outside
 * the cluster which node contacted the origin.
 *
 * Node layout
 * ───────────
 *   nodeA — replication source (configured with  `replicationSource: true` in
 *            the component).  Origin fetches for cache misses should be routed
 *            here; the resulting cache entries replicate out to peers.
 *   nodeB — non-source peer.  Requests a cached record; should NOT trigger an
 *            independent origin fetch after the entry has replicated.
 *
 * Assertions (what is verified today)
 * ─────────────────────────────────────
 *   (a) After a request on nodeB the origin is contacted exactly once (cache-miss
 *       fetch + stampede prevention applies cluster-wide).  Which node contacts
 *       the origin is NOT asserted here — replicationSource routing is not yet
 *       implemented (see harper-pro#416).
 *   (b) The record value is byte-identical on both nodes after replication
 *       converges.
 *   (c) A second request on nodeB is served from the replicated cache without any
 *       additional origin fetch.
 *   (d) A separate id requested from nodeA also caches and replicates to nodeB.
 *
 * What is NOT verified (pending harper-pro#416)
 * ──────────────────────────────────────────────
 *   • That origin fetches are routed specifically to the `replicationSource: true`
 *     node (nodeA).  The skipped test below makes this gap explicit in test output.
 */

import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { cp } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { resolve, basename, join } from 'node:path';
import { sendOperation, fetchWithRetry } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = resolve(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

// ─────────────────────────────────────────────────────────────────────────────
// Mock origin server
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spin up a lightweight HTTP mock origin that:
 *   • POST /fetch  { id, node } → records which node fetched which id, returns
 *                                  { value: "origin-value-<id>" }
 *   • GET  /counts              → { fetchesByNode: { [hostname]: count } }
 *   • POST /reset               → resets all counters
 */
function startMockOrigin() {
	/** @type {Map<string, number>} hostname → fetch count */
	const fetchesByNode = new Map();
	/** @type {Map<string, string>} id → value (deterministic) */
	const values = new Map();

	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			if (req.method === 'POST' && req.url === '/fetch') {
				let parsed;
				try {
					parsed = JSON.parse(body);
				} catch {
					res.writeHead(400);
					res.end('bad json');
					return;
				}
				const { id, node } = parsed;
				fetchesByNode.set(node, (fetchesByNode.get(node) ?? 0) + 1);
				if (!values.has(id)) {
					values.set(id, `origin-value-${id}`);
				}
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ value: values.get(id) }));
				return;
			}
			if (req.method === 'GET' && req.url === '/counts') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ fetchesByNode: Object.fromEntries(fetchesByNode) }));
				return;
			}
			if (req.method === 'POST' && req.url === '/reset') {
				fetchesByNode.clear();
				values.clear();
				res.writeHead(204);
				res.end();
				return;
			}
			res.writeHead(404);
			res.end();
		});
	});

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			const url = `http://127.0.0.1:${port}`;
			resolve({
				url,
				close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
				fetchCounts: async () => {
					const resp = await fetch(`${url}/counts`);
					return (await resp.json()).fetchesByNode;
				},
				totalFetches: async () => {
					const counts = await (await fetch(`${url}/counts`)).json();
					return Object.values(counts.fetchesByNode).reduce((a, b) => a + b, 0);
				},
				reset: () => fetch(`${url}/reset`, { method: 'POST' }),
			});
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Low-level operations fetch that returns the raw response data without asserting
 * the status, so callers can retry on transient failures (e.g. ECONNREFUSED while
 * the replication server is still starting).
 */
async function rawOperation(node, operation) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	});
	return { status: response.status, body: await response.json() };
}

/** Connect nodeB to nodeA and wait until both report a live data-database socket. */
async function connectNodes(nodeA, nodeB) {
	// Obtain a replication token from nodeA. Retry briefly — the replication server
	// may still be coming up when `before` calls us immediately after startup.
	let tokenResp;
	for (let i = 0; i < 20; i++) {
		const result = await rawOperation(nodeA, {
			operation: 'create_authentication_tokens',
			authorization: nodeA.admin,
		});
		if (result.status === 200 && result.body.operation_token) {
			tokenResp = result.body;
			break;
		}
		await delay(300);
	}
	if (!tokenResp) throw new Error('Failed to obtain replication token from nodeA');

	// add_node: retry if nodeA's replication port is not yet listening.
	for (let i = 0; i < 30; i++) {
		const result = await rawOperation(nodeB, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: nodeA.hostname,
			authorization: 'Bearer ' + tokenResp.operation_token,
		});
		// Success or "already exists" are both fine; ECONNREFUSED means replication
		// server not ready yet — wait and retry.
		if (result.status === 200) break;
		const errMsg = JSON.stringify(result.body);
		if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ECONNRESET') || errMsg.includes('connect ')) {
			await delay(500);
			continue;
		}
		// Other 5xx: unexpected, propagate
		throw new Error(`add_node failed (${result.status}): ${errMsg}`);
	}

	// Wait for bidirectional replication sockets to come up.
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

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE = resolve(import.meta.dirname ?? module.path, 'fixture-cache-repl-source');

suite(
	'Cache sourcedFrom cross-node replication (replicationSource fetch routing NOT verified — see harper-pro#416)',
	{ timeout: 180000 },
	(ctx) => {
		/** @type {{ url: string, fetchCounts: () => Promise<Record<string,number>>, totalFetches: () => Promise<number>, reset: () => Promise<void>, close: () => Promise<void> }} */
		let origin;

		before(async () => {
			origin = await startMockOrigin();

			const sharedConfig = (hostname) => ({
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true },
				replication: {
					securePort: hostname + ':9933',
				},
			});

			// Allocate addresses first, then manually copy the fixture into the dataRootDir
			// before calling startHarper. This ensures the pre-allocated hostname is what
			// startHarper actually binds to (startHarper respects ctx.harper.hostname when set),
			// so the replication securePort in the config matches the actual node address.
			// Using startHarper directly (vs setupHarperWithFixture) avoids the hostname loss
			// that occurs when setupHarperWithFixture replaces ctx.harper = { dataRootDir }.
			const [hostnameA, hostnameB] = await Promise.all([
				getNextAvailableLoopbackAddress(),
				getNextAvailableLoopbackAddress(),
			]);

			const [dataRootDirA, dataRootDirB] = await Promise.all([
				mkdtemp(join(tmpdir(), 'harper-integration-test-')),
				mkdtemp(join(tmpdir(), 'harper-integration-test-')),
			]);

			const fixtureBasename = basename(FIXTURE);
			await Promise.all([
				cp(FIXTURE, join(dataRootDirA, 'components', fixtureBasename), { recursive: true, dereference: true }),
				cp(FIXTURE, join(dataRootDirB, 'components', fixtureBasename), { recursive: true, dereference: true }),
			]);

			const ctxA = { name: ctx.name, harper: { hostname: hostnameA, dataRootDir: dataRootDirA } };
			const ctxB = { name: ctx.name, harper: { hostname: hostnameB, dataRootDir: dataRootDirB } };

			await Promise.all([
				startHarper(ctxA, {
					config: sharedConfig(hostnameA),
					env: {
						HARPER_NO_FLUSH_ON_EXIT: true,
						HARPER_TEST_ORIGIN_URL: origin.url,
					},
				}).then(() => { ctx.nodeA = ctxA.harper; }),
				startHarper(ctxB, {
					config: sharedConfig(hostnameB),
					env: {
						HARPER_NO_FLUSH_ON_EXIT: true,
						HARPER_TEST_ORIGIN_URL: origin.url,
					},
				}).then(() => { ctx.nodeB = ctxB.harper; }),
			]);

			console.log('nodeA:', ctx.nodeA.hostname);
			console.log('nodeB:', ctx.nodeB.hostname);

			await connectNodes(ctx.nodeA, ctx.nodeB);
			console.log('cluster connected');
		});

		after(async () => {
			await Promise.all([
				ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
				ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
			]);
			await origin.close();
		});

		test('(a) origin is contacted exactly once on cache miss (which node fetches is not asserted — see harper-pro#416)', async () => {
			await origin.reset();

			const id = 'item-1';

			// Request from nodeB triggers a cache miss. The sourcedFrom source fetches
			// from the mock origin. With replicationSource: true, the intent is that
			// the origin fetch is routed to nodeA; without the routing implementation
			// it will be executed on nodeB directly — either way the total count is 1.
			const response = await fetchWithRetry(`${ctx.nodeB.httpURL}/OriginCache/${id}`);
			equal(response.status, 200, `expected 200 but got ${response.status}`);
			const body = await response.json();
			equal(body.id, id, 'record id should match');
			equal(body.value, `origin-value-${id}`, 'record value should come from origin');

			const total = await origin.totalFetches();
			equal(total, 1, `expected exactly 1 origin fetch for the cache miss, got ${total}`);

			// TODO(harper-pro#416): When replicationSource routing is implemented, tighten
			// this to assert the fetch happened on nodeA specifically.  Before enabling,
			// also verify that `ctx.nodeA.hostname` resolves to the real loopback address
			// (not 'unknown') — the mock origin keys fetch counts by the hostname the
			// Harper node reports, so an unresolved hostname would silently miss the assertion.
			//   const counts = await origin.fetchCounts();
			//   equal(counts[ctx.nodeA.hostname], 1, 'origin fetch should happen on nodeA (replicationSource)');
			//   ok(!counts[ctx.nodeB.hostname], 'nodeB should not contact origin directly');
		});

		// Explicitly skipped: this is the gap harper-pro#416 tracks.  When routing is
		// implemented, remove the `skip` option and wire up the per-node assertions from
		// the TODO block above.
		test(
			'routes origin fetch to the replicationSource node (nodeA) — blocked on harper-pro#416',
			{ skip: 'replicationSource routing not yet implemented — see harper-pro#416' },
			() => {}
		);

		test('(b) record is byte-identical on both nodes after replication converges', async () => {
			const id = 'item-1'; // written in test (a)

			// Wait for the cache entry written during test (a) to replicate to nodeA.
			let recordOnA = null;
			for (let i = 0; i < 40 && !recordOnA; i++) {
				await delay(250);
				const results = await sendOperation(ctx.nodeA, {
					operation: 'search_by_id',
					table: 'OriginCache',
					ids: [id],
					get_attributes: ['id', 'value', 'fetchedBy'],
				});
				if (results.length) recordOnA = results[0];
			}
			ok(recordOnA, `record ${id} did not replicate to nodeA within the wait window`);

			const recordOnB = await sendOperation(ctx.nodeB, {
				operation: 'search_by_id',
				table: 'OriginCache',
				ids: [id],
				get_attributes: ['id', 'value', 'fetchedBy'],
			}).then((r) => r[0]);

			ok(recordOnB, `record ${id} not found on nodeB`);

			// The key values must be identical on both nodes.
			equal(recordOnA.value, recordOnB.value, 'value must be identical on both nodes');
			equal(recordOnA.id, recordOnB.id, 'id must be identical on both nodes');
		});

		test('(c) second request on nodeB is served from replicated cache without re-fetching origin', async () => {
			await origin.reset();

			const id = 'item-1'; // already cached from test (a)/(b)

			// A second HTTP GET for the same id on nodeB should be served from the local
			// replicated cache — no additional origin fetch expected.
			const response = await fetchWithRetry(`${ctx.nodeB.httpURL}/OriginCache/${id}`);
			equal(response.status, 200, `expected 200 but got ${response.status}`);
			const body = await response.json();
			equal(body.value, `origin-value-${id}`, 'value should still match origin');

			const total = await origin.totalFetches();
			equal(total, 0, `expected 0 origin fetches on cache hit, got ${total}`);
		});

		test('(d) separate id also caches and replicates correctly', async () => {
			await origin.reset();

			const id = 'item-2';

			// Request from nodeA this time to exercise the source-node path directly.
			const responseA = await fetchWithRetry(`${ctx.nodeA.httpURL}/OriginCache/${id}`);
			equal(responseA.status, 200);
			const bodyA = await responseA.json();
			equal(bodyA.value, `origin-value-${id}`);

			const fetchesAfterA = await origin.totalFetches();
			equal(fetchesAfterA, 1, 'exactly one origin fetch for nodeA miss');

			// Wait for replication to nodeB.
			let recordOnB = null;
			for (let i = 0; i < 40 && !recordOnB; i++) {
				await delay(250);
				const results = await sendOperation(ctx.nodeB, {
					operation: 'search_by_id',
					table: 'OriginCache',
					ids: [id],
					get_attributes: ['id', 'value'],
				});
				if (results.length) recordOnB = results[0];
			}
			ok(recordOnB, `record ${id} did not replicate from nodeA to nodeB`);
			equal(recordOnB.value, bodyA.value, 'replicated value must match origin value');

			// Now request from nodeB — should hit the replicated cache, no further origin fetch.
			await origin.reset();
			const responseB = await fetchWithRetry(`${ctx.nodeB.httpURL}/OriginCache/${id}`);
			equal(responseB.status, 200);
			const bodyB = await responseB.json();
			equal(bodyB.value, bodyA.value, 'nodeB cache hit must match nodeA origin value');

			const fetchesAfterB = await origin.totalFetches();
			equal(fetchesAfterB, 0, 'no additional origin fetch after replication to nodeB');
		});
	}
);
