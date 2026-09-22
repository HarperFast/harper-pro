/**
 * The unit-test root (unitTestSetup.cjs) must outlive every database opened inside it: 'exit'
 * listeners fire in registration order, so a root removed from the preload's own listener is gone
 * before RocksTransactionLogStore's shutdown() flushes into it, and rocksdb-js reports that as
 * "Failed to flush database during close: IO error ... 000NNN.log" — a throw out of an exit
 * listener, which exits the run 7 with every test passing (harper-pro main at e98500b54).
 *
 * Neither half of that is observable from inside a run, so this drives a child run: exit 0 proves
 * the flush found its files, and the removed root proves the cleanup still happens at all.
 */

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('unit-test storage root lifecycle', function () {
	it('removes the root, and only once the databases opened inside it have been flushed', async function () {
		this.timeout(120_000);
		const child = spawn(
			process.execPath,
			[
				join(root, 'node_modules/mocha/bin/mocha.js'),
				'--require',
				join(root, 'unitTests/unitTestSetup.cjs'),
				join(root, 'unitTests/fixtures/unit-test-setup/opensADatabase.mjs'),
			],
			{ cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
		);

		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
		child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
		const forcedKill = setTimeout(() => child.kill('SIGKILL'), 90_000);
		let result;
		try {
			result = await new Promise((resolveResult, reject) => {
				child.once('error', reject);
				child.once('close', (code, signal) => resolveResult({ code, signal }));
			});
		} finally {
			clearTimeout(forcedKill);
		}

		const output = `\n--- child stdout ---\n${stdout}\n--- child stderr ---\n${stderr}`;
		assert.strictEqual(result.signal, null, `child run had to be killed${output}`);
		assert.strictEqual(result.code, 0, `child run did not exit 0${output}`);

		const testRoot = stdout.match(/^TEST_ROOT=(.+)$/m)?.[1];
		assert.ok(testRoot, `child run never reported its test root${output}`);
		assert.ok(!existsSync(testRoot), `child run left ${testRoot} behind${output}`);
	});
});
