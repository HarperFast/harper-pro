/**
 * Run a JMeter plan (non-GUI) and assert zero failed samples.
 * Used by the acl-connect canary. Needs JMeter + the mqtt-xmeter plugin jar.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** True if a usable `jmeter` binary is on PATH. */
export function hasJMeter() {
	try {
		return spawnSync('jmeter', ['--version'], { stdio: 'ignore' }).status === 0;
	} catch {
		return false;
	}
}

/** Parse a JTL (CSV) and return { total, failed } based on the success column. */
function summarizeJtl(jtlPath) {
	const lines = readFileSync(jtlPath, 'utf8').trim().split(/\r?\n/);
	if (lines.length <= 1) return { total: 0, failed: 0 };
	const header = lines[0].split(',');
	const successIdx = header.indexOf('success');
	let failed = 0;
	for (const line of lines.slice(1)) {
		const cols = line.split(',');
		if (successIdx >= 0 && cols[successIdx] !== 'true') failed++;
	}
	return { total: lines.length - 1, failed };
}

/**
 * @param {string} planPath absolute path to the .jmx plan
 * @param {Record<string,string|number>} props passed as `-Jname=value`
 * @param {object} [opts]
 * @param {string} [opts.jtlPath] where to write the results JTL
 * @param {number} [opts.timeoutMs=120000] hard cap; JMeter is SIGKILLed past this
 * @returns {{ status: number, total: number, failed: number, timedOut: boolean }}
 */
export function runJMeter(planPath, props = {}, { jtlPath, timeoutMs = 120000 } = {}) {
	if (!existsSync(planPath)) throw new Error(`JMeter plan not found: ${planPath}`);
	const dir = mkdtempSync(join(tmpdir(), 'jmeter-'));
	const jtl = jtlPath ?? join(dir, 'results.jtl');

	const args = ['-n', '-t', planPath, '-l', jtl, '-j', join(dir, 'jmeter.log')];
	// HiveMQ client keeps non-daemon threads alive after the test ends, so force a clean exit.
	args.push('-Jjmeterengine.force.system.exit=true');
	for (const [k, v] of Object.entries(props)) args.push(`-J${k}=${v}`);

	console.log(`> jmeter ${args.join(' ')}`);
	const res = spawnSync('jmeter', args, { stdio: 'inherit', timeout: timeoutMs, killSignal: 'SIGKILL' });

	const timedOut = res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGKILL';
	const { total, failed } = existsSync(jtl) ? summarizeJtl(jtl) : { total: 0, failed: 0 };
	return { status: res.status, total, failed, timedOut };
}

/** Run a JMeter plan and throw unless it ran samples and all of them succeeded. */
export function assertJMeter(planPath, props, opts) {
	const { status, total, failed, timedOut } = runJMeter(planPath, props, opts);
	if (timedOut) {
		throw new Error('JMeter did not exit within the timeout. See output above.');
	}
	if (status !== 0) throw new Error(`JMeter exited with code ${status}. See output above.`);
	if (total === 0) throw new Error('JMeter ran zero samples. The plan or broker connection is misconfigured.');
	if (failed > 0) throw new Error(`JMeter had ${failed}/${total} failed samples.`);
	console.log(`JMeter: ${total} samples, 0 failures.`);
}
