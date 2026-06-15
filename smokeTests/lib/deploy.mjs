/**
 * Prepare a cloned component directory and deploy it to a running cluster.
 * targz the dir, deploy_component with replicated + restart, then wait for HTTP workers to settle.
 */
import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { targz } from '@harperfast/integration-testing';
import { sendOperation } from './cluster.mjs';

function run(cmd, args, cwd) {
	console.log(`> ${cmd} ${args.join(' ')} (in ${cwd})`);
	const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
	if (res.status !== 0) {
		throw new Error(`\`${cmd} ${args.join(' ')}\` failed with exit code ${res.status}`);
	}
}

function hasDependencies(dir) {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
		return Object.keys(pkg.dependencies ?? {}).length > 0;
	} catch {
		return false;
	}
}

/**
 * Install deps (if missing) and build (if requested). Idempotent.
 * @param {string} dir component directory
 * @param {object} [opts]
 * @param {boolean} [opts.build=false] run `npm run build`
 * @param {string} [opts.buildArtifact] path (relative to dir) whose presence means "already built"
 */
export function prepareComponent(dir, { build = false, buildArtifact } = {}) {
	if (!existsSync(dir)) throw new Error(`Component directory not found: ${dir}`);
	if (!existsSync(join(dir, 'node_modules')) && hasDependencies(dir)) {
		run('npm', ['install'], dir);
	}
	if (build && (!buildArtifact || !existsSync(join(dir, buildArtifact)))) {
		run('npm', ['run', 'build'], dir);
	}
}

/**
 * Deploy a component to the cluster and pause for the restart to settle.
 * @param {object[]} nodes started cluster nodes
 * @param {string} dir component directory to package
 * @param {string} project component/project name
 * @param {object} [opts]
 * @param {boolean} [opts.replicated=true]
 * @param {boolean} [opts.restart=true]
 * @param {number} [opts.settleMs=10000] pause after deploy for HTTP workers to come back
 */
export async function deployComponent(
	nodes,
	dir,
	project,
	{ replicated = true, restart = true, settleMs = 10000 } = {}
) {
	// Harper creates its own harperdb symlink on deploy_component. A pre-existing symlink from
	// `npm link harperdb` (e.g. from a component's postinstall) will point to a non-existent
	// global location once packaged and extracted to a temp dir, causing Harper to reject the
	// deploy with "not a valid symlink". Strip it so Harper can recreate it correctly.
	const harperdbLink = join(dir, 'node_modules', 'harperdb');
	try {
		if (lstatSync(harperdbLink).isSymbolicLink()) unlinkSync(harperdbLink);
	} catch { /* not present — nothing to do */ }
	const payload = await targz(dir);
	const response = await sendOperation(nodes[0], {
		operation: 'deploy_component',
		project,
		payload,
		replicated,
		restart,
	});
	console.log('deploy_component:', response.message ?? JSON.stringify(response));
	await delay(settleMs);
	return response;
}
