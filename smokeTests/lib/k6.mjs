/**
 * Run a k6 script and assert it passed.
 * Canary scripts define thresholds, so k6 exits non-zero when one is breached.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** True if a usable `k6` binary is on PATH. */
export function hasK6() {
	try {
		return spawnSync('k6', ['version'], { stdio: 'ignore' }).status === 0;
	} catch {
		return false;
	}
}

/**
 * @param {string} scriptPath absolute path to the k6 script
 * @param {Record<string,string|number>} env passed as `-e KEY=VALUE`
 * @param {object} [opts]
 * @param {string} [opts.summaryPath] where to write `--summary-export` JSON
 * @returns {{ status: number, summary: object|null }}
 */
export function runK6(scriptPath, env = {}, { summaryPath } = {}) {
	if (!existsSync(scriptPath)) throw new Error(`k6 script not found: ${scriptPath}`);
	const out = summaryPath ?? join(mkdtempSync(join(tmpdir(), 'k6-')), 'summary.json');

	const args = ['run', '--summary-export', out];
	for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
	args.push(scriptPath);

	console.log(`> k6 ${args.join(' ')}`);
	const res = spawnSync('k6', args, { stdio: 'inherit' });

	let summary = null;
	if (existsSync(out)) {
		try {
			summary = JSON.parse(readFileSync(out, 'utf8'));
		} catch {
			/* leave null */
		}
	}
	return { status: res.status, summary };
}

/** Run a k6 script and throw on non-zero exit. */
export function assertK6(scriptPath, env, opts) {
	const { status, summary } = runK6(scriptPath, env, opts);
	if (status !== 0) {
		throw new Error(`k6 failed (exit ${status}). A threshold was breached. See output above.`);
	}
	return summary;
}
