/**
 * Cluster test for Slice B2 of deployment-tracking redesign (HarperFast/harper#641).
 *
 * Verifies that after Slice B2's changes to harper's `deployComponent`, multi-node
 * deploys deliver the payload via the replicated `hdb_deployment.payload_blob` row
 * attribute (using Harper's existing `BLOB_CHUNK` channel) instead of carrying the
 * payload in the `replicateOperation` body.
 *
 * Assertions:
 *   1. Deploy from node A succeeds on a 3-node cluster.
 *   2. Component is loaded on all three nodes (responds to HTTP).
 *   3. The hdb_deployment row replicates to peers (queryable from node B).
 *   4. The row's `peer_results` is populated on the origin with success entries
 *      for the two peer nodes — proving the origin captured per-peer outcomes
 *      from `replicateOperation`'s return.
 *
 * The OSS-side counterpart for B2 (HarperFast/harper#760) tests the peer-side
 * branch in isolation on a single node; this test verifies the full multi-node
 * round trip the new design depends on.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
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

const NODE_COUNT = 3;
const TERMINAL_STATUSES = new Set(['success', 'failed', 'rolled_back']);

suite('Deployment tracking — multi-node replication (Slice B2)', { timeout: 180000 }, (ctx) => {
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

	test('deploy from node 0 lands on all 3 nodes via the replicated payload_blob', async () => {
		const project = 'b2-deploy-tracking-application';
		const payload = await targz(join(import.meta.dirname, 'fixture'));
		const deployResponse = await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project,
			payload,
			replicated: true,
			restart: true,
		});
		equal(
			deployResponse.message,
			`Successfully deployed: ${project}, restarting Harper`,
			JSON.stringify(deployResponse)
		);
		ok(deployResponse.deployment_id, 'deploy response should carry a deployment_id');
		ctx.deploymentId = deployResponse.deployment_id;

		// Restart was triggered — wait for all three nodes' HTTP workers to come back up.
		await delay(10000);

		// Pick a known route from the fixture component to verify each node has loaded it.
		// The cluster fixture serves /Location/{id} (see fullyConnectedReplication test).
		for (let i = 0; i < NODE_COUNT; i++) {
			const response = await fetchWithRetry(ctx.nodes[i].httpURL + '/Location/2', { retries: 10 });
			equal(
				response.status,
				200,
				`expected component to respond on node ${i}; got ${response.status} from ${ctx.nodes[i].httpURL}`
			);
		}
	});

	test('hdb_deployment row replicates to peers', async () => {
		// Slice A's replicated row should be visible from any node in the cluster.
		await delay(500);
		for (let i = 0; i < NODE_COUNT; i++) {
			const response = await sendOperation(ctx.nodes[i], {
				operation: 'get_deployment',
				deployment_id: ctx.deploymentId,
			});
			equal(
				response.deployment_id,
				ctx.deploymentId,
				`node ${i} should be able to read the replicated hdb_deployment row`
			);
			ok(TERMINAL_STATUSES.has(response.status), `node ${i} sees row in terminal state; saw ${response.status}`);
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
			equal(
				peer.status,
				'success',
				`each peer should have status=success; got ${JSON.stringify(peer)}`
			);
			ok(peer.node, `each peer_result should record the node name; got ${JSON.stringify(peer)}`);
		}
	});
});
