/**
 * Cluster test for deployment-tracking multi-node replication.
 *
 * Verifies that multi-node deploys deliver the payload via the replicated
 * `hdb_deployment.payload_blob` row attribute (using Harper's existing
 * `BLOB_CHUNK` channel) instead of carrying the payload in the `replicateOperation`
 * body.
 *
 * Assertions:
 *   1. Deploy from node A succeeds on a 3-node cluster.
 *   2. The hdb_deployment row replicates to peers (queryable from any node).
 *   3. The row's `peer_results` is populated on the origin with per-peer outcomes
 *      — proving the origin captured them via the onPeerResult callback (real-time
 *      per-peer updates) or, failing that, the aggregate return value.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const NODE_COUNT = 3;
const TERMINAL_STATUSES = new Set(['success', 'failed', 'rolled_back']);

suite('Deployment tracking — multi-node replication', { timeout: 180000 }, (ctx) => {
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
							logging: { colors: false, stdStreams: false, console: true },
							replication: { securePort: nodeCtx.harper.hostname + ':9933' },
						},
						env: { HARPER_NO_FLUSH_ON_EXIT: true },
					});
					return nodeCtx.harper;
				})
		);
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('connect nodes into a fully-connected cluster', async () => {
		const tokenResponse = await sendOperation(ctx.nodes[0], {
			operation: 'create_authentication_tokens',
			authorization: ctx.nodes[0].admin,
		});
		const token = tokenResponse.operation_token;
		for (let j = 1; j < NODE_COUNT; j++) {
			await sendOperation(ctx.nodes[j], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				authorization: 'Bearer ' + token,
			});
		}
		// wait for all nodes to see each other
		let retries = 0;
		while (true) {
			const responses = await Promise.all(
				ctx.nodes.map((node) => sendOperation(node, { operation: 'cluster_status' }))
			);
			const allConnected = responses.every(
				(response) =>
					response.connections.length === NODE_COUNT - 1 &&
					response.connections.every((c) => c.database_sockets.every((s) => s.connected))
			);
			if (allConnected) break;
			if (retries++ > 25) throw new Error('Timed out waiting for cluster to connect');
			await delay(200 * retries);
		}
		await delay(500);
	});

	test('deploy from node 0 returns replicated peer outcomes', async () => {
		const project = 'b2-deploy-tracking-application';
		const payload = await targz(join(import.meta.dirname, 'fixture'));
		// `restart: false` so the deploy completes cleanly without cycling HTTP workers
		// mid-flow — keeps the recorder.finish() write durable so peer_results survives.
		const deployResponse = await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project,
			payload,
			replicated: true,
			restart: false,
		});
		equal(deployResponse.message, `Successfully deployed: ${project}`, JSON.stringify(deployResponse));
		ok(deployResponse.deployment_id, 'deploy response should carry a deployment_id');
		ctx.deploymentId = deployResponse.deployment_id;

		// The deploy_component response carries the replicateOperation return value, which
		// includes per-peer outcomes. Assert at least one peer was contacted so a regression
		// in cluster-connection symmetry surfaces here instead of later.
		ok(
			Array.isArray(deployResponse.replicated),
			`expected deployResponse.replicated to be an array; got ${JSON.stringify(deployResponse.replicated)}`
		);
		ok(
			deployResponse.replicated.length >= 1,
			`expected replicateOperation to contact at least 1 peer; got ${JSON.stringify(deployResponse.replicated)}. ` +
				`If 0, origin's server.nodes is empty — check cluster add_node symmetry.`
		);

		// Give table replication time to settle on peers before we check the row exists everywhere.
		await delay(1000);
	});

	test('hdb_deployment row replicates to peers', async () => {
		// The deployment row should be visible from any node in the cluster.
		// Poll each peer for the terminal-state row rather than relying on a fixed sleep —
		// slower CI shards (especially Node v22) need more wall-clock time for the final
		// finish() put to propagate via table replication.
		const POLL_TIMEOUT_MS = 15000;
		const POLL_INTERVAL_MS = 250;
		for (let i = 0; i < NODE_COUNT; i++) {
			const deadline = Date.now() + POLL_TIMEOUT_MS;
			let response;
			while (Date.now() < deadline) {
				response = await sendOperation(ctx.nodes[i], {
					operation: 'get_deployment',
					deployment_id: ctx.deploymentId,
				});
				if (
					response.deployment_id === ctx.deploymentId &&
					TERMINAL_STATUSES.has(response.status) &&
					response.payload_blob_present
				) {
					break;
				}
				await delay(POLL_INTERVAL_MS);
			}
			equal(
				response.deployment_id,
				ctx.deploymentId,
				`node ${i} should be able to read the replicated hdb_deployment row`
			);
			ok(
				TERMINAL_STATUSES.has(response.status),
				`node ${i} sees row in terminal state within ${POLL_TIMEOUT_MS}ms; saw ${response.status}`
			);
			ok(response.payload_blob_present, `node ${i} should have the payload_blob replicated`);
		}
	});

	test('origin row has peer_results populated with success entries for both peers', async () => {
		const response = await sendOperation(ctx.nodes[0], {
			operation: 'get_deployment',
			deployment_id: ctx.deploymentId,
		});
		ok(Array.isArray(response.peer_results), 'peer_results should be an array');
		equal(
			response.peer_results.length,
			NODE_COUNT - 1,
			`expected ${NODE_COUNT - 1} peer_results, got ${response.peer_results.length}: ${JSON.stringify(response.peer_results)}`
		);
		for (const peer of response.peer_results) {
			equal(peer.status, 'success', `each peer should have status=success; got ${JSON.stringify(peer)}`);
			ok(peer.node, `each peer_result should record the node name; got ${JSON.stringify(peer)}`);
		}
	});
});
