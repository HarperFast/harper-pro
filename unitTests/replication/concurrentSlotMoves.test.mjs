import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const issue = 'https://github.com/HarperFast/harper-pro/issues/1178';
describe('Concurrent slot move owner preservation', function () {
	this.timeout(120_000);
	for (const keyDerived of [true, false])
		for (const retry of [false, true])
			for (const patch of ['body', 'indexed']) {
				if (keyDerived && retry) continue;
				const run = keyDerived || process.env.HARPER_TEST_ATTRIBUTE_MOVE_LEGACY_RED === '1' ? it : it.skip;
				run(
					`${keyDerived ? 'key-derived' : 'experimental attribute'} ${retry ? 'round22 retained retry' : 'round23 committed PATCH'} preserves the owner (${patch}; ${issue})`,
					() => {
						const root = mkdtempSync(join(tmpdir(), 'slot-concurrency-'));
						const fixture = join(
							import.meta.dirname,
							'fixtures/concurrentMoves',
							retry ? 'round22-stub-replication.cjs' : 'round23-no-retry-replication.cjs'
						);
						const env = {
							...process.env,
							PROBE_KEY_DERIVED: keyDerived ? '1' : '0',
							PROBE_NO_RETRY: retry ? '0' : '1',
							PROBE_PATCH: patch,
							PROBE_MARKER: 'native',
						};
						function invoke(mode, store, output, source) {
							const child = spawnSync(process.execPath, [fixture, mode, store, output, ...(source ? [source] : [])], {
								env,
								timeout: 30_000,
								encoding: 'utf8',
							});
							assert.equal(child.status, 0, child.stderr);
							return JSON.parse(readFileSync(output, 'utf8'));
						}
						try {
							const sentPath = join(root, 'send.json');
							const sent = invoke('send', join(root, 'source'), sentPath);
							if (retry) {
								assert.equal(sent.error?.statusCode, 409);
								assert.equal(sent.error.retryable, true);
								assert.match(sent.error.message, /slotabort.RetryRows.*retry-abort/);
							} else {
								assert.equal(sent.error, undefined);
								assert.deepEqual(sent.aborts, []);
								assert.deepEqual(sent.attempts, [sent.originalId]);
							}
							const received = invoke('receive', join(root, 'owner'), join(root, 'receive.json'), sentPath);
							const reopened = invoke('verify', join(root, 'owner'), join(root, 'reopen.json'));
							assert.deepEqual(reopened.primary, received.primary);
							assert.equal(received.primary.flags & 1, 0, 'the current owner must retain a complete body');
							assert.equal(received.primary.slot, keyDerived ? undefined : 1);
							assert.equal(received.primary.value.other, 'concurrent-other');
							assert.equal(received.primary.value.body, retry ? 'concurrent' : 'submitted');
							assert.equal(received.primary.value.score, retry || patch === 'body' ? 2 : 3);
						} finally {
							rmSync(root, { recursive: true, force: true });
						}
					}
				);
			}
});
