/**
 * The unit-test root must outlive every database opened inside it: 'exit' listeners fire in
 * registration order, so a root removed from unitTestSetup.cjs's own preload-time listener is gone
 * before RocksTransactionLogStore's shutdown() flushes into it, and rocksdb-js turns that into a
 * throw out of an exit listener — exit 7 with every test passing.
 *
 * Neither the ordering nor the removal is observable from inside a run, so this drives a child run.
 */

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mochaBin = createRequire(import.meta.url).resolve('mocha/bin/mocha.js');

describe('unit-test storage root lifecycle', function () {
	it('removes the root, and only once the databases opened inside it have been flushed', async function () {
		this.timeout(120_000);
		const child = spawn(
			process.execPath,
			[
				mochaBin,
				'--require',
				join(root, 'unitTests/unitTestSetup.cjs'),
				join(root, 'unitTests/fixtures/unit-test-setup/opensADatabase.mjs'),
			],
			{
				cwd: root,
				// RocksDB is the only engine that registers the flush-on-exit listener this covers, so
				// an inherited HARPER_STORAGE_ENGINE=lmdb would leave the child testing nothing.
				env: { ...process.env, HARPER_STORAGE_ENGINE: 'rocksdb' },
				stdio: ['ignore', 'pipe', 'pipe'],
			}
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
