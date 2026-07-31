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
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { resolveDeployAnswer, buildAbortedResult, buildCmFailureResult } = require(
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
});
