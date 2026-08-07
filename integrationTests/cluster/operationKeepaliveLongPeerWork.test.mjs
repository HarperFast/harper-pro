/**
 * Regression guard for harper-pro#674, which the predicate-level unit test cannot catch: nothing is
 * written on a replicated operation's one-shot WS while the peer executes, so without a keep-alive
 * the receive watchdog terminates it and the origin reports a peer that is still installing as a
 * failed replication. pingInterval/pingTimeout are lowered so that window is seconds instead of the
 * ~120s default, and the install outlasts it.
 */

import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const PROJECT = 'keepalive-long-install';
const FIXTURE_PATH = join(import.meta.dirname, 'fixture-slow-install');

// pingTimeout is the watchdog's silence window; it re-arms once off the WS handshake bytes, so an
// unfixed operation socket dies at ~2x this. The install must outlast that by a clear margin.
const PING_INTERVAL_MS = 1000;
const PING_TIMEOUT_MS = 2000;
const INSTALL_MS = 12_000;
const INSTALL_COMMAND = 'node install-delay.mjs';

suite('Replicated operation survives peer work longer than the watchdog window (#674)', { timeout: 180_000 }, (ctx) => {
	before(async () => {
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const config = (host) => ({
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, console: true, level: 'debug' },
			replication: {
				securePort: host + ':9933',
				pingInterval: PING_INTERVAL_MS,
				pingTimeout: PING_TIMEOUT_MS,
			},
		});
		await startHarper(nodeA, { config: config(nodeA.harper.hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
		await startHarper(nodeB, { config: config(nodeB.harper.hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
		ctx.nodes = [nodeA.harper, nodeB.harper];

		const tokenResp = await sendOperation(ctx.nodes[0], {
			operation: 'create_authentication_tokens',
			authorization: ctx.nodes[0].admin,
		});
		await sendOperation(ctx.nodes[1], {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.nodes[0].hostname,
			authorization: 'Bearer ' + tokenResp.operation_token,
		});
		let connected = false;
		for (let retries = 0; retries < 15 && !connected; retries++) {
			const status = await Promise.all(ctx.nodes.map((n) => sendOperation(n, { operation: 'cluster_status' })));
			// Require sockets to exist: `every` over an empty connections/sockets list is vacuously true,
			// which would report an unmeshed cluster as ready.
			connected = status.every(
				(r) =>
					(r.connections ?? []).length > 0 &&
					r.connections.every(
						(c) => (c.database_sockets ?? []).length > 0 && c.database_sockets.every((s) => s.connected)
					)
			);
			if (!connected) await delay(200 * (retries + 1));
		}
		// Fail here rather than letting the deploy fail later for an unrelated reason.
		ok(connected, 'nodes did not converge to connected before the deploy');
	});

	after(async () => {
		for (const node of ctx.nodes ?? []) await teardownHarper({ harper: node });
	});

	test('deploy_component replicates when the peer install outlasts 2x pingTimeout', async () => {
		const payload = await targz(FIXTURE_PATH);
		const deploy = await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project: PROJECT,
			payload,
			install_command: INSTALL_COMMAND,
			restart: false,
		});

		ok(
			typeof deploy?.message === 'string' && deploy.message.includes(PROJECT),
			`deploy did not succeed: ${JSON.stringify(deploy)}`
		);
		ok(deploy.deployment_id, `deploy response carried no deployment_id: ${JSON.stringify(deploy)}`);

		const row = await sendOperation(ctx.nodes[0], {
			operation: 'get_deployment',
			deployment_id: deploy.deployment_id,
		});
		const peers = row?.peer_results ?? [];
		strictEqual(peers.length, 1, `expected exactly one peer_result, got ${JSON.stringify(peers)}`);
		const failed = peers.filter((peer) => peer.status === 'failed');
		strictEqual(
			failed.length,
			0,
			// Pre-fix this is where the ~2x pingTimeout termination surfaces, as "Connection closed  1006".
			`peer replication failed: ${JSON.stringify(failed)}`
		);

		const components = await sendOperation(ctx.nodes[1], { operation: 'get_components' });
		ok(
			JSON.stringify(components).includes(PROJECT),
			`component did not land on the peer: ${JSON.stringify(components)}`
		);
	});
});
