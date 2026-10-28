import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Transaction } = require('@harperfast/rocksdb-js');
const enabled =
	process.env.HARPER_STORAGE_ENGINE !== 'lmdb' &&
	(typeof Transaction.prototype.usesAbortMarkers === 'function' ||
		process.env.HARPER_TEST_ABORT_MARKER_LEGACY_RED === '1');

(enabled ? describe : describe.skip)('Changed-slot abort markers through replication', function () {
	this.timeout(90_000);
	let root, sent, received, reopened;
	before(() => {
		const parent = fileURLToPath(new URL('../envDir/', import.meta.url));
		mkdirSync(parent, { recursive: true });
		root = mkdtempSync(join(parent, 'slot-markers-'));
		const run = (mode, store) => {
			const output = join(root, mode + '.json');
			const child = spawnSync(
				process.execPath,
				[
					fileURLToPath(new URL('./fixtures/slotRetryReplication.cjs', import.meta.url)),
					mode,
					join(root, store),
					output,
					join(root, 'send.json'),
				],
				{ timeout: 30_000, encoding: 'utf8' }
			);
			assert.equal(child.status, 0, child.stderr);
			return JSON.parse(readFileSync(output, 'utf8'));
		};
		sent = run('send', 'source');
		received = run('receive', 'receiver');
		reopened = run('verify', 'receiver');
	});
	after(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});
	it('does not transmit the abandoned PATCH from the slot0 origin log', () => {
		assert.ok(
			sent.sent.some((entry) => entry.recordId === 'barrier'),
			'the sender advanced beyond the aborted batch'
		);
		assert.ok(!sent.sent.some((entry) => entry.type === 'patch'), 'no abandoned PATCH may reach a slot0 owner');
	});
	it('does not apply an abandoned PATCH to receiver primary, indexes or durable origin history', () => {
		for (const result of [received, reopened]) {
			assert.equal(result.primary.value.zone, 0);
			assert.equal(result.primary.slot, 0);
			assert.deepEqual(result.primary.indexes, sent.primary.indexes);
			assert.ok(!result.audit.some((entry) => entry.type === 'patch'));
		}
	});
});
