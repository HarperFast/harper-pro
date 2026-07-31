/**
 * Regression guard for the non-interactive contract of scripts/patch-release.js
 * (--yes/--cm-trigger/--json), covering the completion-path gaps flagged in PR #638:
 * a requested-but-failed CM dispatch must be terminal (not silently ok:true), --cm-trigger
 * must never bypass the deploy confirmation for a human without --yes, and declining the
 * first confirmation under --json must still emit a parsable RESULT line.
 *
 * These exercise the pure decision helpers directly rather than spawning the script, since
 * main() drives real git/gh state with no seams to stub.
 */
import assert from 'node:assert/strict';
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { resolveDeployAnswer, buildAbortedResult, buildCmFailureResult, writeResult } = require(
	join(root, 'scripts/patch-release.js')
);

describe('patch-release.js non-interactive contract', function () {
	describe('resolveDeployAnswer', function () {
		it('auto-confirms only when --cm-trigger and --yes are both set', function () {
			assert.equal(resolveDeployAnswer({ cmTrigger: true, yesMode: true }), 'y');
		});

		it('defaults to skip for plain --yes (no --cm-trigger)', function () {
			assert.equal(resolveDeployAnswer({ cmTrigger: false, yesMode: true }), 'n');
		});

		it('never auto-bypasses confirmation for --cm-trigger without --yes', function () {
			// Regression: --cm-trigger alone used to force deploy='y', skipping the prompt
			// even for a human running the script interactively.
			assert.equal(resolveDeployAnswer({ cmTrigger: true, yesMode: false }), null);
		});

		it('falls through to an interactive prompt with neither flag', function () {
			assert.equal(resolveDeployAnswer({ cmTrigger: false, yesMode: false }), null);
		});
	});

	describe('buildAbortedResult', function () {
		it('reports ok:false with an explicit aborted marker', function () {
			assert.deepEqual(buildAbortedResult(), {
				ok: false,
				error: 'aborted',
				aborted: true,
				pushed: false,
				cmTriggered: false,
			});
		});
	});

	describe('buildCmFailureResult', function () {
		it('preserves partial release state so a caller can tell "pushed, deploy failed" from "nothing happened"', function () {
			const { message, extra } = buildCmFailureResult({
				pushed: true,
				coreVersion: 'v5.2.1',
				proVersion: 'v5.2.1',
				error: 'gh: authentication failed',
			});
			assert.match(message, /gh: authentication failed/);
			assert.deepEqual(extra, {
				pushed: true,
				cmTriggered: false,
				coreVersion: 'v5.2.1',
				proVersion: 'v5.2.1',
			});
		});

		it('normalizes a null coreVersion (core not bumped this release)', function () {
			const { extra } = buildCmFailureResult({
				pushed: true,
				coreVersion: null,
				proVersion: 'v5.2.1',
				error: 'network error',
			});
			assert.equal(extra.coreVersion, null);
		});
	});

	describe('writeResult', function () {
		// die()/the abort path/the success path all funnel through this one synchronous fd
		// write to avoid the process.exit() truncation race on a piped stdout — exercise the
		// actual write (via a real fd), not just the object it serializes.
		let filePath;
		let fd;

		beforeEach(function () {
			filePath = join(tmpdir(), `patch-release-result-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
			fd = openSync(filePath, 'w');
		});

		afterEach(function () {
			closeSync(fd);
			rmSync(filePath, { force: true });
		});

		it('writes a single parsable "RESULT: {...}" line synchronously', function () {
			writeResult({ ok: true, pushed: true }, fd);
			const written = readFileSync(filePath, 'utf8');
			assert.equal(written, 'RESULT: ' + JSON.stringify({ ok: true, pushed: true }) + '\n');
			assert.deepEqual(JSON.parse(written.replace(/^RESULT: /, '')), { ok: true, pushed: true });
		});
	});
});
