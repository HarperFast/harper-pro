import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function runRunner(fixture, env) {
	const runner = spawn(
		process.execPath,
		[join(root, 'integrationTests/run.mjs'), join(root, 'unitTests/fixtures/integration-runner', fixture)],
		{ cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	let stdout = '';
	let stderr = '';
	runner.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
	runner.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
	const forcedKill = setTimeout(() => runner.kill('SIGKILL'), 5_000);
	try {
		const { code, signal } = await new Promise((resolveResult, reject) => {
			runner.once('error', reject);
			runner.once('close', (code, signal) => resolveResult({ code, signal }));
		});
		return { code, signal, stdout, stderr };
	} finally {
		clearTimeout(forcedKill);
	}
}

describe('integration test runner', function () {
	it('fails fast when a failed test leaks a child process', async function () {
		this.timeout(10_000);
		const { code, signal, stdout, stderr } = await runRunner('fail-and-leak.mjs', {
			HARPER_INTEGRATION_TEST_EXIT_GRACE_MS: '100',
		});

		assert.strictEqual(signal, null, `runner was killed after hanging:\n${stdout}\n${stderr}`);
		assert.strictEqual(code, 1);
		assert.match(stderr, /Failure details captured before final reporting stalled/);
		assert.match(stderr, /AssertionError \[ERR_ASSERTION\]/);
		assert.match(stderr, /\+ 'actual'/);
		assert.match(stderr, /fail-and-leak\.mjs:\d+:/);
		assert.match(stderr, /Forcing exit so the CI job fails fast/);
	});

	it('does not fail the run for a failing todo test, but does for a real failure beside it', async function () {
		this.timeout(10_000);
		const todoOnly = await runRunner('failing-todo.mjs');
		assert.strictEqual(todoOnly.code, 0, `${todoOnly.stdout}\n${todoOnly.stderr}`);
		const withReal = await runRunner('failing-todo.mjs', { FAIL_FOR_REAL: '1' });
		assert.strictEqual(withReal.code, 1, `${withReal.stdout}\n${withReal.stderr}`);
	});
});
