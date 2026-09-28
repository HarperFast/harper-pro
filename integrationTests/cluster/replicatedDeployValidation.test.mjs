/**
 * A replicated deploy_component end to end: sent from one node's operations API, built and test-loaded on a
 * peer's worker, and answered back. Nodes log at debug, where both ends print the replicated operation, so the
 * log check covers the sender's user record, with its refresh token, being forwarded or logged.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { readLog, sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const PROJECT = 'replicated-deploy-validation';
const FIXTURE_PATH = join(import.meta.dirname, 'fixture-replicated-deploy-validation');
// A healthy deploy of this fixture answers in a few seconds.
const DEPLOY_ANSWER_MS = 90_000;

suite('Replicated deploy_component answers and keeps the user record to itself', { timeout: 240_000 }, (ctx) => {
	before(async () => {
		ctx.nodes = [];
		for (let i = 0; i < 2; i++) {
			const node = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			await startHarper(node, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, console: true, level: 'debug' },
					replication: { securePort: node.harper.hostname + ':9933' },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});
			// Pushed as each starts, so a second start that throws still leaves the first for `after`.
			ctx.nodes.push(node.harper);
		}

		const tokenResponse = await sendOperation(ctx.nodes[0], {
			operation: 'create_authentication_tokens',
			authorization: ctx.nodes[0].admin,
		});
		await sendOperation(ctx.nodes[1], {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.nodes[0].hostname,
			authorization: 'Bearer ' + tokenResponse.operation_token,
		});
		let connected = false;
		for (let retries = 0; retries < 15 && !connected; retries++) {
			const status = await Promise.all(ctx.nodes.map((node) => sendOperation(node, { operation: 'cluster_status' })));
			// Require sockets to exist: `every` over an empty list would report an unmeshed cluster as ready.
			connected = status.every(
				(response) =>
					(response.connections ?? []).length > 0 &&
					response.connections.every(
						(connection) =>
							(connection.database_sockets ?? []).length > 0 &&
							connection.database_sockets.every((socket) => socket.connected)
					)
			);
			if (!connected) await delay(200 * (retries + 1));
		}
		ok(connected, 'nodes did not converge to connected before the deploy');
	});

	after(async () => {
		for (const node of ctx.nodes ?? []) await teardownHarper({ harper: node });
	});

	test('the peer loads the candidate and answers', async () => {
		const deploy = await sendOperation(
			ctx.nodes[0],
			{ operation: 'deploy_component', project: PROJECT, payload: await targz(FIXTURE_PATH), restart: false },
			{ signal: AbortSignal.timeout(DEPLOY_ANSWER_MS) }
		);
		equal(deploy.message, `Successfully deployed: ${PROJECT}`, JSON.stringify(deploy));
		equal(deploy.replicated?.length, 1, `expected one peer result: ${JSON.stringify(deploy.replicated)}`);
		equal(deploy.replicated[0].message, `Successfully deployed: ${PROJECT}`, JSON.stringify(deploy.replicated));

		const row = await sendOperation(ctx.nodes[0], { operation: 'get_deployment', deployment_id: deploy.deployment_id });
		equal(row.status, 'success', JSON.stringify(row));
		equal(
			(row.peer_results ?? []).filter((peer) => peer.status === 'failed').length,
			0,
			JSON.stringify(row.peer_results)
		);
	});

	test("neither end forwards or logs the requesting user's refresh token", async () => {
		for (const node of ctx.nodes) {
			const log = await readLog(node);
			ok(log.includes('deploy_component'), `expected ${node.hostname}'s debug log to record the deploy`);
			ok(!log.includes('refresh_token'), `${node.hostname}'s log printed a refresh_token`);
		}
	});
});
