import { suite, test, before, after } from 'node:test';
import { deepEqual, equal, match, ok } from 'node:assert';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { sendOperation, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const NODE_COUNT = 2;
const LOCKFILE = '{"name":"install-fingerprint","lockfileVersion":3,"packages":{}}\n';
const sha256 = (content) => createHash('sha256').update(content).digest('hex');

const scratch = [];

function fixture(files) {
	const dir = mkdtempSync(join(tmpdir(), 'install-fingerprint-'));
	scratch.push(dir);
	cpSync(join(import.meta.dirname, 'fixture'), dir, { recursive: true });
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'install-fingerprint', version: '1.0.0' }));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

suite('Install fingerprints — the origin reports a peer that installed differently', { timeout: 300000 }, (ctx) => {
	const nodeContexts = [];

	before(async () => {
		// Settled before a failure is thrown, so teardown never races a launch that is still starting.
		const launches = await Promise.allSettled(
			Array.from({ length: NODE_COUNT }, async (_, index) => {
				const nodeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
				nodeContexts[index] = nodeCtx;
				await startHarper(nodeCtx, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: false, console: true },
						replication: { securePort: nodeCtx.harper.hostname + ':9933' },
					},
					env: { HARPER_NO_FLUSH_ON_EXIT: true },
				});
			})
		);
		const failedLaunch = launches.find((launch) => launch.status === 'rejected');
		if (failedLaunch) throw failedLaunch.reason;
		ctx.nodes = nodeContexts.map((nodeCtx) => nodeCtx.harper);
		const { operation_token } = await sendOperation(ctx.nodes[0], {
			operation: 'create_authentication_tokens',
			authorization: ctx.nodes[0].admin,
		});
		await sendOperation(ctx.nodes[1], {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.nodes[0].hostname,
			authorization: 'Bearer ' + operation_token,
		});
		await waitForCondition(
			async (signal) => {
				const statuses = await Promise.all(
					ctx.nodes.map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal }))
				);
				// `every` over an empty socket list is vacuously true, which would report an unmeshed cluster as ready.
				return statuses.every(
					(s) =>
						s.connections?.length === 1 &&
						s.connections.every((c) => c.database_sockets?.length > 0 && c.database_sockets.every((d) => d.connected))
				);
			},
			{ pollMs: 200, description: 'the cluster to connect' }
		);
		await delay(500);
	});

	after(async () => {
		await Promise.allSettled(
			nodeContexts.filter((nodeCtx) => nodeCtx?.harper?.process).map((nodeCtx) => teardownHarper(nodeCtx))
		);
		for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
	});

	const deploy = async (project, dir, extra = {}) =>
		sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project,
			payload: await targz(dir),
			replicated: true,
			restart: false,
			...extra,
		});

	test('nodes that installed alike report the same fingerprint, and nothing is said', async () => {
		const project = 'install-fingerprint-alike';
		const response = await deploy(project, fixture({ 'package-lock.json': LOCKFILE }));
		const expected = { lockfiles: { 'package-lock.json': sha256(LOCKFILE) } };
		deepEqual(response.install, expected, "the origin's own fingerprint");
		equal(response.replicated?.length, 1, JSON.stringify(response.replicated));
		deepEqual(response.replicated[0].install, expected, "the peer's own fingerprint reached the origin");
		equal(response.replicated[0].install_matches, true);
		equal(response.message, `Successfully deployed: ${project}`);

		const row = await sendOperation(ctx.nodes[0], {
			operation: 'get_deployment',
			deployment_id: response.deployment_id,
		});
		deepEqual(row.install_fingerprint, expected);
		equal(row.peer_results[0].install_matches, true, JSON.stringify(row.peer_results));
	});

	test('a peer whose install wrote a different lockfile is named, and the deploy still succeeds', async () => {
		const project = 'install-fingerprint-differs';
		const dir = fixture({
			'write-lock.js':
				"require('node:fs').writeFileSync('package-lock.json', JSON.stringify({ writtenBy: process.pid }) + '\\n');\n",
		});
		const response = await deploy(project, dir, { install_command: 'node write-lock.js' });
		equal(response.replicated?.length, 1, JSON.stringify(response.replicated));
		const [peer] = response.replicated;
		equal(peer.install_matches, false, JSON.stringify(peer));
		deepEqual(peer.install_differs, ['package-lock.json']);
		ok(peer.node, 'the peer is named');
		equal(
			response.message,
			`Successfully deployed: ${project} Install fingerprints differ from this node's on 1 of 1 peer node(s): ` +
				`${peer.node} (package-lock.json).`
		);

		const row = await sendOperation(ctx.nodes[0], {
			operation: 'get_deployment',
			deployment_id: response.deployment_id,
		});
		equal(row.status, 'success');
		equal(row.peer_results[0].install_matches, false, JSON.stringify(row.peer_results));
		deepEqual(row.peer_results[0].install_differs, ['package-lock.json']);
		match(
			JSON.stringify(row.event_log.filter((entry) => entry.event === 'warning')),
			/Install fingerprints differ/,
			'the warning is in the event log a streaming caller replays'
		);
	});
});
