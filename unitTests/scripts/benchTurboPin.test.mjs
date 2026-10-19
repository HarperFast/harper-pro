import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const guardPath = join(root, 'benchmarks/ycsb/check-cpu-pinned.mts');
const supervisorPath = join(root, 'benchmarks/ycsb/runner/bench-runner-supervisor.sh');

function writeFile(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

// P-cores 0-1 (base 2.3 GHz) and E-cores 2-3 (base 1.7 GHz), like the bench host.
function fakeSysfs(dir, { noTurbo, maxFreqs }) {
	const cpuRoot = join(dir, 'sys/devices/system/cpu');
	writeFile(join(cpuRoot, 'online'), '0-3\n');
	if (noTurbo !== undefined) writeFile(join(cpuRoot, 'intel_pstate/no_turbo'), `${noTurbo}\n`);
	const bases = [2300000, 2300000, 1700000, 1700000];
	bases.forEach((base, cpu) => {
		writeFile(join(cpuRoot, `cpu${cpu}/cpufreq/base_frequency`), `${base}\n`);
		writeFile(join(cpuRoot, `cpu${cpu}/cpufreq/scaling_max_freq`), `${maxFreqs?.[cpu] ?? base}\n`);
	});
	return join(dir, 'sys');
}

describe('YCSB nightly CPU pin guard', function () {
	let dir;
	beforeEach(function () {
		dir = mkdtempSync(join(tmpdir(), 'cpu-pin-'));
	});
	afterEach(function () {
		rmSync(dir, { recursive: true, force: true });
	});

	function runGuard(sysfsRoot) {
		const outputPath = join(dir, 'output');
		const summaryPath = join(dir, 'summary');
		const statePath = join(dir, 'results/cpu-state.json');
		const r = spawnSync(process.execPath, [guardPath, statePath], {
			encoding: 'utf8',
			timeout: 10000,
			env: { ...process.env, SYSFS_ROOT: sysfsRoot, GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath },
		});
		assert.equal(r.status, 0, r.stderr);
		return {
			stdout: r.stdout,
			output: readFileSync(outputPath, 'utf8'),
			summary: readFileSync(summaryPath, 'utf8'),
			state: JSON.parse(readFileSync(statePath, 'utf8')),
		};
	}

	it('allows publishing with turbo off and every CPU at base frequency', function () {
		const result = runGuard(fakeSysfs(dir, { noTurbo: 1 }));
		assert.equal(result.output, 'pinned=true\n');
		assert.equal(result.state.pinned, true);
		assert.equal(result.state.cpus.length, 4);
		assert.doesNotMatch(result.stdout, /::warning::/);
		assert.match(result.summary, /Pinned: \*\*true\*\*/);
	});

	it('refuses with turbo on', function () {
		const result = runGuard(fakeSysfs(dir, { noTurbo: 0, maxFreqs: [4900000, 4900000, 3800000, 3800000] }));
		assert.equal(result.output, 'pinned=false\n');
		assert.match(result.stdout, /::warning::.*no_turbo is 0/);
		assert.match(result.stdout, /cpu0 \(4900000 vs 2300000\)/);
	});

	it('refuses a frequency cap below base even with turbo off', function () {
		const result = runGuard(fakeSysfs(dir, { noTurbo: 1, maxFreqs: [2000000, 2000000, 1700000, 1700000] }));
		assert.equal(result.output, 'pinned=false\n');
		assert.match(result.stdout, /::warning::.*cpu0 \(2000000 vs 2300000\), cpu1/);
		assert.doesNotMatch(result.stdout, /cpu2/);
		assert.equal(result.state.pinned, false);
	});

	it('refuses when intel_pstate is absent', function () {
		const result = runGuard(fakeSysfs(dir, {}));
		assert.equal(result.output, 'pinned=false\n');
		assert.match(result.stdout, /no_turbo is unreadable/);
	});
});

// The supervisor needs flock and md5sum from util-linux/coreutils, so this runs on Linux only.
(process.platform === 'linux' ? describe : describe.skip)('bench runner supervisor turbo ownership', function () {
	this.timeout(20000);
	let dir, bin, noTurboPath, callLog, lockDir;
	const realSleep = spawnSync('bash', ['-c', 'command -v sleep'], { encoding: 'utf8' }).stdout.trim();

	function stub(name, body) {
		const path = join(bin, name);
		writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
		chmodSync(path, 0o755);
	}

	beforeEach(function () {
		dir = mkdtempSync(join(tmpdir(), 'bench-supervisor-'));
		bin = join(dir, 'bin');
		mkdirSync(bin);
		lockDir = join(dir, 'lock');
		callLog = join(dir, 'calls');
		writeFileSync(callLog, '');
		const sysfsRoot = fakeSysfs(dir, { noTurbo: 0 });
		noTurboPath = join(sysfsRoot, 'devices/system/cpu/intel_pstate/no_turbo');
		stub(
			'sudo',
			`echo "sudo $*" >> "${callLog}"
[ "$*" = "-n cpupower set --turbo-boost 0" ] && echo 1 > "${noTurboPath}"
[ "$*" = "-n cpupower set --turbo-boost 1" ] && echo 0 > "${noTurboPath}"
exit 0`
		);
		// One queued harper-bench job until the first drain starts; none after.
		stub(
			'gh',
			`queued="${join(dir, 'drained')}"
[ "$2" = -i ] && printf 'HTTP/2.0 200 OK\\r\\n\\r\\n'
case "$*" in
	*registration-token*) echo token ;;
	*runs/1/jobs*) echo '{"jobs":[{"status":"queued","labels":["self-hosted","harper-bench"]}]}' ;;
	*status=queued*) [ -e "$queued" ] && echo '{"workflow_runs":[]}' || echo '{"workflow_runs":[{"id":1}]}' ;;
esac`
		);
		stub(
			'docker',
			`touch "${join(dir, 'drained')}"
echo "docker no_turbo=$(cat "${noTurboPath}")" >> "${callLog}"
case "$FAKE_JOB" in
	fail) exit 1 ;;
	hang) exec "${realSleep}" 30 ;;
	stop) kill -TERM "$(ps -o ppid= -p "$PPID" | tr -d ' ')" ;;
esac`
		);
		// The poll sleep ends the run after the first pass, through the supervisor's TERM trap.
		stub('sleep', 'kill -TERM "$PPID"');
	});
	afterEach(function () {
		rmSync(dir, { recursive: true, force: true });
	});

	function runSupervisor(env = {}) {
		return new Promise((resolve, reject) => {
			const child = spawn('bash', [supervisorPath], {
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					REPOS: 'HarperFast/harper-pro',
					SYSFS_ROOT: join(dir, 'sys'),
					ETAG_DIR: join(dir, 'etags'),
					BENCH_LOCK_DIR: lockDir,
					MAX_JOB_SECONDS: '1',
					...env,
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			child.stdout.on('data', (data) => (stdout += data));
			child.stderr.on('data', (data) => (stdout += data));
			child.on('error', reject);
			child.on('exit', (code) => resolve({ code, stdout, calls: readFileSync(callLog, 'utf8').trim().split('\n') }));
		});
	}

	for (const job of ['ok', 'fail', 'hang']) {
		it(`runs the job with turbo off and turns it back on after a ${job} job`, async function () {
			const { code, stdout, calls } = await runSupervisor({ FAKE_JOB: job });
			assert.equal(code, 0, stdout);
			assert.deepEqual(calls, [
				'sudo -n cpupower set --turbo-boost 0',
				'docker no_turbo=1',
				'sudo -n cpupower set --turbo-boost 1',
			]);
			assert.equal(readFileSync(noTurboPath, 'utf8').trim(), '0');
		});
	}

	it('turns turbo back on when stopped mid-job', async function () {
		const { code, stdout, calls } = await runSupervisor({ FAKE_JOB: 'stop' });
		assert.equal(code, 0, stdout);
		assert.match(stdout, /stopping/);
		assert.deepEqual(calls, [
			'sudo -n cpupower set --turbo-boost 0',
			'docker no_turbo=1',
			'sudo -n cpupower set --turbo-boost 1',
		]);
	});

	it('turns stale turbo-off back on when the lock is free', async function () {
		writeFileSync(noTurboPath, '1\n');
		writeFileSync(join(dir, 'drained'), '');
		const { code, stdout, calls } = await runSupervisor();
		assert.equal(code, 0, stdout);
		assert.deepEqual(calls, ['sudo -n cpupower set --turbo-boost 1']);
		assert.equal(readFileSync(noTurboPath, 'utf8').trim(), '0');
	});

	it('leaves turbo off while another benchmark holds the lock', async function () {
		writeFileSync(noTurboPath, '1\n');
		writeFileSync(join(dir, 'drained'), '');
		mkdirSync(lockDir, { recursive: true });
		const holder = spawn('flock', [join(lockDir, 'lock'), realSleep, '30'], { stdio: 'ignore', detached: true });
		try {
			await new Promise((resolve) => setTimeout(resolve, 300));
			const { code, stdout, calls } = await runSupervisor();
			assert.equal(code, 0, stdout);
			assert.deepEqual(calls, ['']);
			assert.equal(readFileSync(noTurboPath, 'utf8').trim(), '1');
		} finally {
			process.kill(-holder.pid);
		}
	});
});
