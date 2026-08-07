/**
 * End-to-end regression guard for harper-pro#674: a replicated operation whose peer-side execution
 * outlives the receive-watchdog window.
 *
 * The origin sends a replicated operation over a one-shot WS and awaits OPERATION_RESPONSE with no
 * timeout. Nothing is written on that socket while the peer executes, so without a keep-alive the
 * receive watchdog terminates it after 2 x replication.pingTimeout and the origin rejects the pending
 * response with `Connection closed  1006` — reporting a peer that is still installing as a failed
 * replication. Closing the socket cancels nothing on the peer, so the deploy also lands anyway.
 *
 * pingInterval/pingTimeout are lowered here so that window is seconds rather than the ~120s default,
 * and the component's install sleeps well past it. On unfixed code the deploy fails with a failed
 * peer_result; with the keepalive the peer's pongs hold the connection open for the whole install.
 *
 * The unit test (unitTests/replication/operationConnectionKeepalive.test.mjs) covers the predicates
 * only — this is the one that proves the wired lifecycle.
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
// `install.command` is split on spaces before spawning, so the script cannot contain any.
const INSTALL_COMMAND = `node -e setTimeout(()=>{},${INSTALL_MS})`;

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
		for (let retries = 0; retries < 15; retries++) {
			const status = await Promise.all(ctx.nodes.map((n) => sendOperation(n, { operation: 'cluster_status' })));
			if (status.every((r) => (r.connections ?? []).every((c) => (c.database_sockets ?? []).every((s) => s.connected))))
				break;
			await delay(200 * (retries + 1));
		}
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
