/**
 * A replicated deploy leaves every node running the tree its origin built (harper#2315 step 7, harper#2295).
 *
 * The install command succeeds only where `STEP7_ORIGIN` is set, and writes the installing process's pid into the
 * tree. A peer that built the release itself would fail its install; a peer that took the origin's build holds the
 * origin's pid. Tree digests are compared with core's own manifest walk.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';
import { inventoryBuild } from '../../dist/core/components/buildArtifact.js';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const NODE_COUNT = 2;
const INSTALL = 'node install.js';

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), 'replicated-build-'));
	cpSync(join(import.meta.dirname, 'fixture'), dir, { recursive: true });
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'replicated-build', version: '1.0.0' }));
	writeFileSync(
		join(dir, 'install.js'),
		"if (!process.env.STEP7_ORIGIN) process.exit(1);\nrequire('fs').writeFileSync('built.txt', String(process.pid));\n"
	);
	return dir;
}

suite('Replicated builds — every node runs the origin’s tree', { timeout: 300000 }, (ctx) => {
	const scratch = [];
	const componentDir = (node, project) => join(node.dataRootDir, 'components', project);
	const treeOf = async (node, project) => (await inventoryBuild(componentDir(node, project))).tree;
	const builtBy = (node, project) => readFileSync(join(componentDir(node, project), 'built.txt'), 'utf8');

	before(async () => {
		ctx.nodes = await Promise.all(
			Array.from({ length: NODE_COUNT }, async (_, index) => {
				const nodeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
				await startHarper(nodeCtx, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: false, console: true },
						replication: { securePort: nodeCtx.harper.hostname + ':9933' },
					},
					env: { HARPER_NO_FLUSH_ON_EXIT: true, ...(index === 0 ? { STEP7_ORIGIN: '1' } : {}) },
				});
				return nodeCtx.harper;
			})
		);
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
		for (let retries = 0; ; retries++) {
			const statuses = await Promise.all(ctx.nodes.map((node) => sendOperation(node, { operation: 'cluster_status' })));
			if (
				statuses.every(
					(s) => s.connections.length === 1 && s.connections.every((c) => c.database_sockets.every((d) => d.connected))
				)
			)
				break;
			if (retries > 25) throw new Error('Timed out waiting for the cluster to connect');
			await delay(200 * (retries + 1));
		}
		await delay(500);
	});

	after(async () => {
		if (ctx.nodes) await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
		for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
	});

	async function assertSameBuild(response, project) {
		const [origin, peer] = ctx.nodes;
		const row = await sendOperation(origin, { operation: 'get_deployment', deployment_id: response.deployment_id });
		const tree = row.artifact_build?.tree;
		ok(tree, `the origin recorded its build: ${JSON.stringify(row)}`);
		ok(row.artifact_blob_present || row.status === 'success', 'and carried it in the row');
		equal(response.replicated?.length, 1, JSON.stringify(response.replicated));
		equal(response.replicated[0].artifact, tree, 'the peer answered with the tree it admitted');
		equal(await treeOf(origin, project), tree, 'the origin runs its build');
		equal(await treeOf(peer, project), tree, 'and so does the peer');
		equal(builtBy(peer, project), builtBy(origin, project), 'down to the output of the origin’s install');
		return tree;
	}

	test('a payload deploy', async () => {
		const project = 'replicated-build-payload';
		const response = await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project,
			payload: await targz(fixture()),
			install_command: INSTALL,
			replicated: true,
			restart: false,
		});
		await assertSameBuild(response, project);
	});

	test('a package deploy, whose peer never resolves the package', async () => {
		const project = 'replicated-build-package';
		const tarballDir = mkdtempSync(join(tmpdir(), 'replicated-build-package-'));
		scratch.push(tarballDir);
		const tarball = join(tarballDir, 'component.tgz');
		writeFileSync(tarball, Buffer.from(await targz(fixture()), 'base64'));
		const response = await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project,
			package: `file:${tarball}`,
			install_command: INSTALL,
			replicated: true,
			restart: false,
		});
		await assertSameBuild(response, project);
	});

	test('a stage, then its activation', async () => {
		const project = 'replicated-build-stage';
		const staged = await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project,
			payload: await targz(fixture()),
			install_command: INSTALL,
			replicated: true,
			activate: false,
		});
		equal(staged.replicated[0].staged, true, JSON.stringify(staged.replicated));
		const activated = await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project,
			deployment_id: staged.deployment_id,
			replicated: true,
		});
		const row = await sendOperation(ctx.nodes[0], { operation: 'get_deployment', deployment_id: staged.deployment_id });
		equal(activated.replicated[0].artifact, row.artifact_build.tree, 'the peer activated the tree the origin names');
		equal(await treeOf(ctx.nodes[1], project), row.artifact_build.tree);
		equal(builtBy(ctx.nodes[1], project), builtBy(ctx.nodes[0], project));
	});

	test('the deploy’s own restart re-resolves nothing', async () => {
		const project = 'replicated-build-restart';
		const tarballDir = mkdtempSync(join(tmpdir(), 'replicated-build-restart-'));
		scratch.push(tarballDir);
		const tarball = join(tarballDir, 'component.tgz');
		writeFileSync(tarball, Buffer.from(await targz(fixture()), 'base64'));
		// Each node answers after its own restart, and that reload is where a package used to be resolved again: a
		// rebuild on either node would leave a tree other than the one the origin published.
		const response = await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project,
			package: `file:${tarball}`,
			install_command: INSTALL,
			replicated: true,
			restart: true,
		});
		await assertSameBuild(response, project);
	});
});
