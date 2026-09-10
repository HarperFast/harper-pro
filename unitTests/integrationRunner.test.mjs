import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('integration test runner', function () {
	it('fails fast when a failed test leaks a child process', async function () {
		this.timeout(10_000);
		const runner = spawn(
			process.execPath,
			[join(root, 'integrationTests/run.mjs'), join(root, 'unitTests/fixtures/integration-runner/fail-and-leak.mjs')],
			{
				cwd: root,
				env: { ...process.env, HARPER_INTEGRATION_TEST_EXIT_GRACE_MS: '100' },
				stdio: ['ignore', 'pipe', 'pipe'],
			}
		);

		let stdout = '';
		let stderr = '';
		runner.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
		runner.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
		const forcedKill = setTimeout(() => runner.kill('SIGKILL'), 5_000);
		let result;
		try {
			result = await new Promise((resolveResult, reject) => {
				runner.once('error', reject);
				runner.once('close', (code, signal) => resolveResult({ code, signal }));
			});
		} finally {
			clearTimeout(forcedKill);
		}

		assert.strictEqual(result.signal, null, `runner was killed after hanging:\n${stdout}\n${stderr}`);
		assert.strictEqual(result.code, 1);
		assert.match(stderr, /Failure details captured before final reporting stalled/);
		assert.match(stderr, /AssertionError \[ERR_ASSERTION\]/);
		assert.match(stderr, /\+ 'actual'/);
		assert.match(stderr, /fail-and-leak\.mjs:\d+:/);
		assert.match(stderr, /Forcing exit so the CI job fails fast/);
	});
});
