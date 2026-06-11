/**
 * Spin up an in-process multi-node Harper cluster from this repo's dist/.
 * Modeled on integrationTests/cluster/fullyConnectedReplication.test.mjs.
 */
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
	sendOperation,
} from '@harperfast/integration-testing';

// Resolve dist/bin/harper.js relative to repo root (this file lives at smokeTests/lib/).
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ??= join(
	import.meta.dirname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

export { sendOperation };

/**
 * Start nodeCount nodes on isolated loopback addresses and fully connect them.
 * Loopback addresses are allocated sequentially to avoid file-lock contention on the
 * shared pool (concurrent acquisitions amplify retry waits and flake on shared
 * runners). Harper processes themselves still start in parallel.
 * @returns {Promise<object[]>} the started harper contexts
 */
export async function startCluster(nodeCount = 2, { testLMDB = false } = {}) {
	const hostnames = [];
	for (let i = 0; i < nodeCount; i++) {
		hostnames.push(await getNextAvailableLoopbackAddress());
	}

	const nodes = await Promise.all(
		hostnames.map(async (hostname) => {
			const nodeCtx = { name: 'component', harper: { hostname } };
			await startHarper(nodeCtx, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, console: true },
					replication: { securePort: hostname + ':9933' },
					storage: { engine: testLMDB ? 'lmdb' : 'rocksdb' },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});
			return nodeCtx.harper;
		})
	);

	if (nodeCount > 1) await joinCluster(nodes);
	return nodes;
}

/** Join nodes[1..] to nodes[0] and poll cluster_status until every node is connected. */
async function joinCluster(nodes) {
	const { operation_token: token } = await sendOperation(nodes[0], {
		operation: 'create_authentication_tokens',
		authorization: nodes[0].admin,
	});

	for (let i = 1; i < nodes.length; i++) {
		await sendOperation(nodes[i], {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: nodes[0].hostname,
			authorization: 'Bearer ' + token,
		});
	}

	const expected = nodes.length - 1;
	for (let attempt = 1; ; attempt++) {
		const statuses = await Promise.all(nodes.map((n) => sendOperation(n, { operation: 'cluster_status' })));
		const connected = statuses.every(
			(s) =>
				s.connections.length === expected &&
				s.connections.every((c) => c.database_sockets.every((sock) => sock.connected))
		);
		if (connected) return;
		if (attempt > 20) throw new Error('Timed out waiting for cluster to connect');
		await delay(200 * attempt);
	}
}

/** Tear down every node. */
export async function teardownCluster(nodes = []) {
	await Promise.allSettled(nodes.map((node) => teardownHarper({ harper: node })));
}
