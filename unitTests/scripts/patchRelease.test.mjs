/**
 * Regression guard for the non-interactive contract of scripts/patch-release.js
 * (--yes/--cm-trigger/--json), covering the completion-path gaps flagged in PR #638:
 * a requested-but-failed CM dispatch must be terminal (not silently ok:true), --cm-trigger
 * must never bypass the deploy confirmation for a human without --yes, and declining the
 * first confirmation under --json must still emit a parsable RESULT line. Also covers
 * getArg's flag-with-no-usable-value guard, its require.main-only die() contract, the
 * --version-name validation, and the deriveVersionName CM-slot rule.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const scriptPath = join(root, 'scripts/patch-release.js');
const {
	getArg,
	deriveVersionName,
	resolveDeployAnswer,
	buildAbortedResult,
	buildCmFailureResult,
	buildSuccessResult,
	writeResult,
} = require(scriptPath);

describe('patch-release.js non-interactive contract', function () {
	describe('getArg', function () {
		it('returns the default when the flag is absent', function () {
			assert.equal(getArg('--branch', 'v5.0', ['--dry-run']), 'v5.0');
		});

		it('returns the value following a present flag', function () {
			assert.equal(getArg('--branch', 'v5.0', ['--branch', 'v5.1']), 'v5.1');
		});

		it('treats the string "0" as a real value, not a missing one', function () {
			// '0' is falsy-looking but a valid arg.
			assert.equal(getArg('--bump', 'patch', ['--bump', '0']), '0');
		});

		it('a repeated flag is last-occurrence-wins', function () {
			assert.equal(getArg('--branch', 'v5.0', ['--branch', 'v5.1', '--branch', 'v5.2']), 'v5.2');
		});

		// die() calls process.exit(), which would tear down this test process if invoked
		// in-process — so these run the real CLI as a subprocess instead. An empty PATH and a
		// timeout contain a regression that falls through past die() into main()'s real git/gh
		// calls, or waits on stdin.
		describe('fails fast via die() instead of silently falling back to the default', function () {
			function runCli(args) {
				return spawnSync(process.execPath, [scriptPath, ...args], {
					encoding: 'utf8',
					timeout: 5000,
					env: { ...process.env, PATH: '' },
				});
			}

			it('when the flag is the last argument (value missing)', function () {
				const r = runCli(['--branch']);
				assert.equal(r.status, 1);
				assert.match(r.stderr, /--branch requires a value/);
			});

			it('when the next argument is empty', function () {
				const r = runCli(['--branch', '']);
				assert.equal(r.status, 1);
				assert.match(r.stderr, /--branch requires a value/);
			});

			it('when the next argument is another flag (`--branch --dry-run`)', function () {
				const r = runCli(['--branch', '--dry-run']);
				assert.equal(r.status, 1);
				assert.match(r.stderr, /--branch requires a value/);
			});

			it('when a later occurrence of the flag is malformed, even though the first is fine', function () {
				// indexOf-based lookup would validate only the first '--branch' and silently
				// proceed on 'v5.0', ignoring that the second occurrence has no value.
				const r = runCli(['--branch', 'v5.0', '--branch']);
				assert.equal(r.status, 1);
				assert.match(r.stderr, /--branch requires a value/);
			});

			it('still emits a parsable RESULT line under --json', function () {
				const r = runCli(['--json', '--branch', '--dry-run']);
				assert.equal(r.status, 1);
				const resultLine = r.stdout.split('\n').find((line) => line.startsWith('RESULT: '));
				assert.ok(resultLine, `expected a RESULT line on stdout, got:\n${r.stdout}`);
				const result = JSON.parse(resultLine.slice('RESULT: '.length));
				assert.equal(result.ok, false);
				assert.match(result.error, /--branch requires a value/);
			});

			it('does not exit the host process when the script is only require()d, not run', function () {
				// This is exactly how the top of this file imports the script's own exports.
				const r = spawnSync(
					process.execPath,
					['-e', 'require(process.argv[1])', '--', scriptPath, '--branch', '--dry-run'],
					{ encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: '' } }
				);
				assert.equal(r.status, 0);
			});

			it('still validates for real on an explicit call, even though import-time parsing is guarded', function () {
				// The require.main guard above must not leak into explicit calls to the exported
				// getArg (how tests exercise its validation) — only the implicit, no-args-supplied
				// case (this module's own top-level parsing) is guarded.
				const r = spawnSync(
					process.execPath,
					['-e', "require(process.argv[1]).getArg('--branch', 'v5.0', ['--branch'])", '--', scriptPath],
					{ encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: '' } }
				);
				assert.equal(r.status, 1);
				assert.match(r.stderr, /--branch requires a value/);
			});
		});
	});

	describe('--version-name validation', function () {
		// Same die()-routing contract as getArg's failures: an invalid --version-name must exit
		// nonzero and, under --json, still emit a parsable RESULT line — it used to exit via a
		// bare err()+process.exit(1) that skipped the RESULT line entirely.
		it('dies via die(), emitting a parsable RESULT line under --json', function () {
			const r = spawnSync(process.execPath, [scriptPath, '--json', '--version-name', 'bogus'], {
				encoding: 'utf8',
				timeout: 5000,
				env: { ...process.env, PATH: '' },
			});
			assert.equal(r.status, 1);
			const resultLine = r.stdout.split('\n').find((line) => line.startsWith('RESULT: '));
			assert.ok(resultLine, `expected a RESULT line on stdout, got:\n${r.stdout}`);
			const result = JSON.parse(resultLine.slice('RESULT: '.length));
			assert.equal(result.ok, false);
			assert.match(result.error, /--version-name "bogus" is invalid/);
		});
	});

	describe('deriveVersionName', function () {
		it('derives "next" for a prerelease target', function () {
			assert.equal(deriveVersionName('5.2.0-beta.1', null), 'next');
		});

		it('derives "stable" for a GA target', function () {
			assert.equal(deriveVersionName('5.2.1', null), 'stable');
		});

		it('lets an explicit --version-name override win even when it mismatches the derived slot', function () {
			assert.equal(deriveVersionName('5.2.1', 'next'), 'next'); // GA forced into next
			assert.equal(deriveVersionName('5.2.0-beta.1', 'stable'), 'stable'); // prerelease forced into stable
		});

		it('handles a --set-version prerelease-line transition target (alpha.N -> beta.1)', function () {
			// scripts/patch-release.js's own doc example for --set-version: semver.inc can't
			// express this step, so it's a hand-picked target rather than a computed one.
			assert.equal(deriveVersionName('5.2.0-beta.1', null), 'next');
			assert.equal(deriveVersionName('5.2.0-rc.10', null), 'next');
		});

		it('handles a leading "v" the same as a bare version', function () {
			// semver's version regex accepts an optional 'v' prefix, so this needs no special casing.
			assert.equal(deriveVersionName('v5.2.0-beta.1', null), 'next');
			assert.equal(deriveVersionName('v5.2.1', null), 'stable');
		});
	});

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

	describe('buildSuccessResult', function () {
		it('reports the projected core version and bump in a core-bumping dry run', function () {
			assert.deepEqual(
				buildSuccessResult({
					target: '5.0.33',
					coreVersion: null,
					proVersion: 'v5.0.33',
					coreBumping: true,
					pushed: false,
					cmTriggered: false,
					dryRun: true,
				}),
				{
					ok: true,
					target: 'v5.0.33',
					coreVersion: 'v5.0.33',
					proVersion: 'v5.0.33',
					coreBumped: true,
					pushed: false,
					cmTriggered: false,
					dryRun: true,
				}
			);
		});

		it('leaves core null and unbumped in a non-core-bumping dry run', function () {
			assert.deepEqual(
				buildSuccessResult({
					target: '5.1.28',
					coreVersion: null,
					proVersion: 'v5.1.28',
					coreBumping: false,
					pushed: false,
					cmTriggered: false,
					dryRun: true,
				}),
				{
					ok: true,
					target: 'v5.1.28',
					coreVersion: null,
					proVersion: 'v5.1.28',
					coreBumped: false,
					pushed: false,
					cmTriggered: false,
					dryRun: true,
				}
			);
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
