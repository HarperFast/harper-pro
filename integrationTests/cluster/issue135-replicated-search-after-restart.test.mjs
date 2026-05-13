/**
 * Scenario B for serent-canopy issue #135.
 *
 * Insert rows on node 0, wait for replication to drain to node 1, restart node 1,
 * then query node 1 via the Resource SDK path. This is the most likely repro
 * vector — index entries for REPLICATED rows may not survive a restart on the
 * receiving node, while the ops API (which scans primaryStore) still sees them.
 *
 * Kept in its own file because `node --test` runs top-level suites concurrently
 * and Scenario A (single-node) interferes with this one when colocated.
 */
import { suite, test, before, after } from 'node:test';
import { equal } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, targz, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, fetchWithRetry } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const PROJECT_NAME = 'issue135-app';
const REP_ROW_COUNT = 50;
const REP_SNAPSHOT_ID = 'replicated-snapshot';
const NODE_COUNT = 2;

async function pollHealth(node, { retries = 40, intervalMs = 2000 } = {}) {
	let last;
	for (let i = 0; i < retries; i++) {
		try {
			const r = await fetch(`${node.operationsAPIURL}/health`);
			if (r.ok) return;
			last = new Error(`status ${r.status}`);
		} catch (err) {
			last = err;
		}
		await delay(intervalMs);
	}
	throw new Error(`Node ${node.hostname} never became healthy: ${last?.message}`);
}

suite(
	'Issue #135: Resource SDK search on replication-receiving node after restart (Scenario B)',
	{ timeout: 300000 },
	(ctx) => {
		before(async () => {
			ctx.nodes = await Promise.all(
				Array(NODE_COUNT)
					.fill(null)
					.map(async () => {
						const nodeCtx = {
							name: ctx.name,
							harper: { hostname: await getNextAvailableLoopbackAddress() },
						};
						await startHarper(nodeCtx, {
							config: {
								analytics: { aggregatePeriod: -1 },
								replication: { securePort: nodeCtx.harper.hostname + ':9933' },
							},
						});
						return nodeCtx.harper;
					})
			);

			// Connect node 1 -> node 0 with an auth token.
			const tokenResp = await sendOperation(ctx.nodes[0], {
				operation: 'create_authentication_tokens',
			});
			const token = tokenResp.operation_token;
			await sendOperation(ctx.nodes[1], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				authorization: 'Bearer ' + token,
			});

			// Poll cluster_status until both nodes see each other as fully connected.
			let retries = 0;
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const statuses = await Promise.all(ctx.nodes.map((n) => sendOperation(n, { operation: 'cluster_status' })));
				const fullyConnected = statuses.every(
					(s) =>
						s.connections.length === NODE_COUNT - 1 &&
						s.connections.every((c) => c.database_sockets.every((sock) => sock.connected))
				);
				if (fullyConnected) break;
				if (retries++ > 20) {
					throw new Error('Cluster did not fully connect: ' + JSON.stringify(statuses));
				}
				await delay(500 * retries);
			}

			// Deploy the fixture component (replicated, so both nodes get it).
			const payload = await targz(join(import.meta.dirname, 'issue135-fixture'));
			await sendOperation(ctx.nodes[0], {
				operation: 'deploy_component',
				project: PROJECT_NAME,
				payload,
				replicated: true,
				restart: true,
			});
			await delay(35000);
			for (const node of ctx.nodes) await pollHealth(node);
		});

		after(async () => {
			if (!ctx.nodes) return;
			await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
		});

		test('Resource SDK search on receiving node returns full row set after restart', async () => {
			// Insert rows on node 0 only.
			const records = Array.from({ length: REP_ROW_COUNT }, (_, i) => ({
				id: `rep-${i}`,
				snapshotId: REP_SNAPSHOT_ID,
				data: `payload-${i}`,
			}));
			await sendOperation(ctx.nodes[0], {
				operation: 'insert',
				table: 'ScoreEvidence',
				records,
			});

			// Wait for replication to drain to node 1 (poll ops API until it sees them).
			let retries = 0;
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const onNode1 = await sendOperation(ctx.nodes[1], {
					operation: 'search_by_value',
					table: 'ScoreEvidence',
					search_attribute: 'snapshotId',
					search_value: REP_SNAPSHOT_ID,
				});
				if (onNode1.length === REP_ROW_COUNT) break;
				if (retries++ > 20) {
					throw new Error(`Replication didn't drain to node 1: got ${onNode1.length}/${REP_ROW_COUNT}`);
				}
				await delay(500 * retries);
			}
			console.log(`Replication drained: node 1 sees ${REP_ROW_COUNT} rows via ops API`);

			// Restart node 1 (the receiving node). The data on node 1 came from replication,
			// not from a local write — this is the case where the bug is hypothesized to live.
			await sendOperation(ctx.nodes[1], { operation: 'restart' }).catch(() => {});
			await delay(5000);
			await pollHealth(ctx.nodes[1], { retries: 60, intervalMs: 2000 });

			// Ops API on node 1 (oracle).
			const opsAfter = await sendOperation(ctx.nodes[1], {
				operation: 'search_by_value',
				table: 'ScoreEvidence',
				search_attribute: 'snapshotId',
				search_value: REP_SNAPSHOT_ID,
			});
			equal(
				opsAfter.length,
				REP_ROW_COUNT,
				`ops API on node 1 after restart: expected ${REP_ROW_COUNT}, got ${opsAfter.length}`
			);

			// Resource SDK on node 1 - the path under test.
			const sdkResp = await fetchWithRetry(
				`${ctx.nodes[1].httpURL}/SearchCount?snapshotId=${encodeURIComponent(REP_SNAPSHOT_ID)}`
			);
			const sdkBody = await sdkResp.json();
			console.log(`Resource SDK on node 1 post-restart: ${sdkBody.count} rows`, sdkBody.error ?? '');

			equal(
				sdkBody.count,
				REP_ROW_COUNT,
				`Resource SDK tables.ScoreEvidence.search on replication-receiving node returned ${sdkBody.count} rows ` +
					`but ops API returned ${opsAfter.length} — issue #135 fingerprint: ` +
					`regular-index search drops replicated rows after restart.`
			);
		});
	}
);
