#!/usr/bin/env node
'use strict';
/**
 * Cuts a patch release across harper (core) and harper-pro.
 *
 * Assumes cherry-picking onto the release branch has already been done by the
 * cherry-pick CI workflow. This script just verifies state and packages the
 * release: bumps versions, syncs the core submodule, tags, and pushes.
 *
 * Flow:
 *   1. For each repo, display:
 *        - merged PRs whose milestones target the release line
 *        - commits on origin/<RELEASE_BRANCH> since the last release tag
 *      Verify backports by ancestry, cherry-pick trailers or stable patch IDs.
 *   2. After confirmation:
 *        - bump core version + tag (if core has new commits)
 *        - run build-tools/sync-core.sh to point harper-pro at the bumped core
 *        - bump harper-pro version + tag
 *        - push both repos and their release tags
 *
 * Usage:
 *   node scripts/patch-release.js [options]
 *
 * Options:
 *   --branch <name>        Release branch (default: v5.0)
 *   --core-branch <name>   Core release branch (default: same as --branch; use when core RC branch has a different name, e.g. rc/X.Y.Z-core)
 *   --source <name>        Source branch (default: main)
 *   --bump <type>     npm version bump: patch|minor|major|prerelease (default: patch)
 *   --version-name <slot>  CM version slot: stable|next. Defaults to `next` for a
 *                     prerelease target and `stable` otherwise — only pass this to
 *                     force a deliberate mismatch.
 *   --dry-run         Preview without making changes
 *   --yes             Non-interactive: auto-confirm all prompts. CM deploy (prompt 2) defaults to
 *                     NO in this mode — pass --cm-trigger to opt in. This is intentional: in
 *                     interactive mode prompt 2 defaults YES on EOF, which would silently deploy;
 *                     non-interactive mode inverts that default to be safe.
 *   --cm-trigger      Request CM release-to-environments. Combined with --yes, auto-confirms prompt
 *                     2 (non-interactive opt-in). Without --yes, still prompts interactively — it
 *                     only changes the prompt's wording, never bypasses confirmation. When the
 *                     trigger itself fails after being explicitly requested, that's a terminal
 *                     error (nonzero exit, RESULT ok:false) even though the release itself may
 *                     already be pushed.
 *   --json            Print a final "RESULT: {...}" JSON line for machine parsing. Also emits on
 *                     fatal error paths (RESULT: {"ok":false,"error":"..."}, nonzero exit) and on
 *                     an aborted confirmation prompt (RESULT: {"ok":false,"error":"aborted",
 *                     "aborted":true}, exit 0 — the user declined, nothing failed).
 */

const { execFileSync, execSync, spawnSync } = require('node:child_process');
const { existsSync, writeSync } = require('fs');
const path = require('path');
const readline = require('readline');

// ── Logging ───────────────────────────────────────────────────────────────────
// Defined before Args below: getArg() can call die(), which uses err()/writeResult() here —
// a const read before its own declaration line has executed is a TDZ ReferenceError, not the
// intended die() message, so this section has to be in place first.
const C = {
	reset: '\x1b[0m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	cyan: '\x1b[36m',
	dim: '\x1b[2m',
	bold: '\x1b[1m',
};
const log = (m) => console.log(m);
const ok = (m) => console.log(C.green + m + C.reset);
const warn = (m) => console.warn(C.yellow + m + C.reset);
const err = (m) => console.error(C.red + m + C.reset);
const info = (m) => console.log(C.cyan + m + C.reset);
const header = (m) => log(`\n${C.bold}${C.cyan}${'━'.repeat(60)}\n  ${m}\n${'━'.repeat(60)}${C.reset}`);

// A plain process.stdout.write() races process.exit(): when stdout is a pipe (the standard
// --json/dispatch setup), the write is async and exit() can tear the process down before it
// flushes, dropping the RESULT line. A raw fd write via fs.writeSync is synchronous, so it's
// guaranteed to land first. `fd` is overridable so tests can assert on the exact bytes written
// without redirecting real stdout.
function writeResult(result, fd = 1) {
	writeSync(fd, 'RESULT: ' + JSON.stringify(result) + '\n');
}

function die(message, code = 1, extra = {}, emitResult = JSON_OUTPUT) {
	err(message);
	if (emitResult) {
		const cleanMessage = typeof message === 'string' ? message.trim() : message;
		writeResult({ ok: false, error: cleanMessage, ...extra });
	}
	process.exit(code);
}

// ── Runtime dependencies ──────────────────────────────────────────────────────
// Skipped on require(): die() would exit the importing process instead of throwing below.
if (require.main === module) {
	try {
		require.resolve('semver');
	} catch {
		die(`\n  Error: semver is not installed. Run \`npm ci\` in ${path.resolve(__dirname, '..')} first.`, 1, {}, true);
	}
}
const semver = require('semver');

// ── Args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const YES_MODE = argv.includes('--yes');
const CM_TRIGGER = argv.includes('--cm-trigger');
// Computed before any getArg() call below — see the Logging section's note on why.
const JSON_OUTPUT = argv.includes('--json');
const RELEASE_BRANCH = getArg('--branch', 'v5.0');
const CORE_RELEASE_BRANCH = getArg('--core-branch', RELEASE_BRANCH);
const SOURCE_BRANCH = getArg('--source', 'main');
const LABEL = getArg('--label', null);
const VERSION_BUMP = getArg('--bump', 'patch'); // patch | minor | major | prerelease
// Explicit target version (without leading 'v'), overriding the --bump computation.
// Needed for prerelease-line transitions semver.inc can't express in one step, e.g.
// alpha.N → beta.1 (`--set-version 5.2.0-beta.1`).
const SET_VERSION = getArg('--set-version', null);
// CM version slot. Derived from the target version when unset — a prerelease goes
// to `next`, a stable release to `stable`. Set explicitly only to force a
// deliberate mismatch.
const VERSION_NAME = getArg('--version-name', null);

// Returns the value after the LAST occurrence of `flag` in `args` (repeats override,
// last wins), or `def` if `flag` is absent. Every occurrence is validated, not just the
// one returned: a flag with no usable next value (end of argv, empty, or another flag)
// dies rather than silently falling back to `def`. Explicit calls (an `args` array is
// passed — how tests exercise validation) always validate for real. Only the implicit
// case (`args` omitted, i.e. this module's own top-level parsing of the real argv) skips
// die() when require.main !== module — a require()-only import (as the test file does,
// to reach the other exports) must never be able to exit the host process just because
// its own unrelated process.argv happens to collide with a flag name.
function getArg(flag, def, args) {
	const usingProcessArgv = args === undefined;
	if (usingProcessArgv) args = argv;
	let value;
	let found = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== flag) continue;
		found = true;
		const next = args[i + 1];
		if (!next || next.startsWith('--')) {
			if (usingProcessArgv && require.main !== module) return def;
			die(`\n  Error: ${flag} requires a value.`);
		}
		value = next;
	}
	return found ? value : def;
}

// Decides the CM-deploy prompt answer from flags: 'y'/'n' to auto-answer non-interactively,
// or null to fall through to an interactive prompt. --cm-trigger alone (no --yes) always falls
// through — it must never bypass confirmation for a human running the script by hand.
function resolveDeployAnswer({ cmTrigger, yesMode }) {
	if (cmTrigger && yesMode) return 'y';
	if (!cmTrigger && yesMode) return 'n';
	return null;
}

function buildAbortedResult() {
	return { ok: false, error: 'aborted', aborted: true, pushed: false, cmTriggered: false };
}

// Builds the die() args for a CM-trigger failure that was explicitly requested via
// --cm-trigger — preserves whatever state the run had already reached (e.g. pushed: true)
// so a machine caller can tell "release pushed, deploy trigger failed" from "nothing happened".
function buildCmFailureResult({ pushed, coreVersion, proVersion, error }) {
	return {
		message: `CM release-to-environments trigger failed: ${error}`,
		extra: { pushed, cmTriggered: false, coreVersion: coreVersion ?? null, proVersion },
	};
}

// ── Validate args ─────────────────────────────────────────────────────────────
if (LABEL && require.main === module) die('--label is no longer supported; PR milestones determine backport targets.');
if (VERSION_NAME && VERSION_NAME !== 'stable' && VERSION_NAME !== 'next' && require.main === module) {
	die(`\n  Error: --version-name "${VERSION_NAME}" is invalid. Expected "stable" or "next".`);
}

// ── Shell helpers ─────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
	return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

function runSafe(cmd) {
	const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
	return { out: r.stdout.trim(), errText: r.stderr.trim(), code: r.status ?? 1 };
}

// ── User prompt ───────────────────────────────────────────────────────────────
async function prompt(question) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) =>
		rl.question(question, (ans) => {
			rl.close();
			resolve(ans.trim());
		})
	);
}

// ── Git / GitHub helpers ──────────────────────────────────────────────────────
function detectGhRepo() {
	const remote = run('git remote get-url origin');
	const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
	if (!match) throw new Error(`Cannot parse GitHub repo from remote: ${remote}`);
	return match[1];
}

// Most recent semver tag reachable from origin/RELEASE_BRANCH, with its commit date.
function getLastRelease(branch = RELEASE_BRANCH) {
	const tagR = runSafe(`git describe --tags --abbrev=0 --match 'v*.*.*' "origin/${branch}"`);
	if (tagR.code !== 0 || !tagR.out) return null;
	const tag = tagR.out;
	const dateR = runSafe(`git log -1 --format=%aI "${tag}"`);
	if (dateR.code !== 0 || !dateR.out) return null;
	return { tag, date: dateR.out };
}

function milestoneTargetsRelease(milestone, releaseLine) {
	const target = milestone?.replace(/^(v\d+\.\d+)\.\d+.*$/, '$1').match(/^v(\d+)\.(\d+)$/);
	const release = releaseLine.match(/^v(\d+)\.(\d+)$/);
	return !!(target && release && Number(target[1]) === Number(release[1]) && Number(target[2]) <= Number(release[2]));
}

function runFile(command, args, opts = {}) {
	return execFileSync(command, args, {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		timeout: 600_000,
		...opts,
	}).trim();
}

function getMilestonePRs(ghRepo, releaseLine) {
	const output = runFile('gh', [
		'api',
		`repos/${ghRepo}/pulls?state=closed&base=${encodeURIComponent(SOURCE_BRANCH)}&per_page=100`,
		'--paginate',
		'--jq',
		'.[] | select(.merged_at != null) | {number, title, merge_commit_sha, milestone: .milestone.title, base: .base.ref} | @json',
	]);
	return output
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((pr) => pr.base === SOURCE_BRANCH && milestoneTargetsRelease(pr.milestone, releaseLine))
		.map((pr) => {
			if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || !/^[0-9a-f]{40}$/.test(pr.merge_commit_sha)) {
				throw new Error(`Invalid merge metadata for ${ghRepo} PR #${pr.number}`);
			}
			return { number: pr.number, title: pr.title, mergeCommit: { oid: pr.merge_commit_sha } };
		});
}

function isPRPresent(pr, { commitShas, cherryPickedShas, patchIds }) {
	const present = (commit) =>
		commitShas.has(commit.oid) ||
		cherryPickedShas.has(commit.oid) ||
		!!(commit.patchId && patchIds.has(commit.patchId));
	return present(pr.mergeCommit) || !!(pr.commits?.length && pr.commits.every(present));
}

function getPatchIds(gitArgs) {
	const output = runFile('bash', [
		'-o',
		'pipefail',
		'-c',
		'git "$@" | git patch-id --stable',
		'patch-release',
		...gitArgs,
	]);
	return output
		.split('\n')
		.filter(Boolean)
		.map((line) => line.split(' ')[0]);
}

function getMissingPRs(prs, branch, ghRepo) {
	if (!prs.length) return [];
	const releaseRef = `origin/${branch}`;
	const history = runFile('git', ['log', '--format=%H%x00%B%x00', releaseRef]).split('\0');
	const evidence = { commitShas: new Set(), cherryPickedShas: new Set(), patchIds: new Set() };
	for (let i = 0; i < history.length - 1; i += 2) {
		evidence.commitShas.add(history[i].trim());
		for (const match of history[i + 1].matchAll(/^\(cherry picked from commit ([0-9a-f]{40})\)$/gm)) {
			evidence.cherryPickedShas.add(match[1]);
		}
	}
	let missing = prs.filter((pr) => !evidence.commitShas.has(pr.mergeCommit.oid));
	if (!missing.length) return [];
	const common = runFile('git', ['merge-base', `origin/${SOURCE_BRANCH}`, releaseRef]);
	evidence.patchIds = new Set(
		getPatchIds(['log', '--format=%H', '--patch', '--binary', '--diff-merges=first-parent', `${common}..${releaseRef}`])
	);
	const patchBySha = new Map();
	const commitWithPatch = (oid) => {
		if (!patchBySha.has(oid)) patchBySha.set(oid, getPatchIds(['diff', '--binary', `${oid}^1`, oid])[0]);
		return { oid, patchId: patchBySha.get(oid) };
	};
	missing = missing.filter((pr) => {
		pr.mergeCommit = commitWithPatch(pr.mergeCommit.oid);
		pr.mergeParents = runFile('git', ['rev-list', '--parents', '-n', '1', pr.mergeCommit.oid]).split(' ').length - 1;
		return pr.mergeParents < 2 || !isPRPresent(pr, evidence);
	});
	if (!missing.length) return [];
	const headRef = (pr) => `refs/patch-release/${process.pid}/pr-${pr.number}`;
	try {
		try {
			runFile('git', ['fetch', 'origin', ...missing.map((pr) => `+refs/pull/${pr.number}/head:${headRef(pr)}`)]);
		} catch (error) {
			warn(`Could not verify original PR heads: ${error.message}`);
			return missing;
		}
		return missing.filter((pr) => {
			const original = JSON.parse(
				runFile('gh', ['api', `repos/${ghRepo}/pulls/${pr.number}/commits?per_page=100`, '--paginate', '--slurp'])
			).flat();
			if (!original.length || original.length >= 250) return true;
			if (original.some((commit) => !/^[0-9a-f]{40}$/.test(commit.sha))) {
				throw new Error(`Cannot verify complete commit list for ${ghRepo} PR #${pr.number}`);
			}
			const commits = original
				.filter((commit) => commit.parents.length === 1)
				.map((commit) => commitWithPatch(commit.sha))
				.filter((commit) => commit.patchId);
			for (const commit of original.filter((commit) => commit.parents.length > 1)) {
				let automaticTree;
				if (commit.parents.length === 2) {
					try {
						automaticTree = runFile('git', ['merge-tree', '--write-tree', `${commit.sha}^1`, `${commit.sha}^2`]);
					} catch (error) {
						if (error.status !== 1) throw error;
					}
				}
				// Ordinary picks cannot prove edits recorded only in a merge resolution.
				if (automaticTree !== runFile('git', ['rev-parse', `${commit.sha}^{tree}`])) commits.push({ oid: commit.sha });
			}
			if (!commits.length) return true;
			const originalShas = new Set(original.map((commit) => commit.sha));
			const first = runFile('git', ['rev-list', '--reverse', '--topo-order', headRef(pr)])
				.split('\n')
				.find((sha) => originalShas.has(sha));
			if (!first) throw new Error(`PR head does not contain the original commits for ${ghRepo} #${pr.number}`);
			const commonBase = runFile('git', ['merge-base', `${pr.mergeCommit.oid}^1`, headRef(pr)]);
			const baseShas = new Set(runFile('git', ['rev-list', commonBase]).split('\n'));
			const aggregateBase = original.some((commit) => baseShas.has(commit.sha)) ? `${first}^1` : commonBase;
			const aggregate = getPatchIds(['diff', '--binary', aggregateBase, headRef(pr)])[0];
			// GitHub's merge SHA may represent only the last commit of a rebase.
			const wholeMerge = pr.mergeParents > 1 || original.length === 1 || aggregate === pr.mergeCommit.patchId;
			const mergeCommit = wholeMerge ? pr.mergeCommit : { patchId: aggregate };
			return !isPRPresent({ mergeCommit, commits }, evidence);
		});
	} finally {
		runFile('git', ['update-ref', '--stdin'], { input: missing.map((pr) => `delete ${headRef(pr)}\n`).join('') });
	}
}

function getReleaseBranchCommits(lastTag, branch = RELEASE_BRANCH) {
	const range = lastTag ? `${lastTag}..origin/${branch}` : `origin/${branch}`;
	const output = runFile('git', ['log', range, '--format=%h%x09%s']);
	if (!output) return [];
	return output
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [sha, ...rest] = line.split('\t');
			return { sha, subject: rest.join('\t') };
		});
}

// ── Per-repo status display ───────────────────────────────────────────────────
function showRepoStatus({ absPath, name, branch = RELEASE_BRANCH }) {
	header(name);
	process.chdir(absPath);
	const ghRepo = detectGhRepo();
	info(`  GitHub repo: ${ghRepo}`);

	log('  Fetching from origin...');
	runFile('git', [
		'fetch',
		'origin',
		'--tags',
		`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
		`+refs/heads/${SOURCE_BRANCH}:refs/remotes/origin/${SOURCE_BRANCH}`,
	]);

	let localBranchExists = false;
	try {
		runFile('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
		localBranchExists = true;
	} catch (error) {
		if (error.status !== 1) throw error;
	}
	if (localBranchExists) {
		try {
			runFile('git', ['merge-base', '--is-ancestor', branch, `origin/${branch}`]);
		} catch (error) {
			if (error.status !== 1) throw error;
			throw new Error(`Local ${branch} has commits absent from origin/${branch}; synchronize it before releasing.`);
		}
	}

	const last = getLastRelease(branch);
	if (last) info(`  Last release: ${last.tag} (${last.date})`);
	else warn(`  No prior semver tag on ${branch}.`);

	const version = semver.parse(readPackageVersion(`origin/${branch}`));
	const releaseLine = /^v\d+\.\d+$/.test(branch) ? branch : `v${version.major}.${version.minor}`;
	const prs = getMilestonePRs(ghRepo, releaseLine);
	prs.sort((a, b) => a.number - b.number);

	const commits = getReleaseBranchCommits(last?.tag, branch);

	log(`\n  ${C.bold}Merged PRs with milestones targeting ${releaseLine}:${C.reset}`);
	if (prs.length === 0) {
		log(`    ${C.dim}(none)${C.reset}`);
	} else {
		for (const pr of prs) {
			log(`    #${String(pr.number).padEnd(5)} ${pr.mergeCommit.oid.slice(0, 8)}  ${pr.title}`);
		}
	}

	log(`\n  ${C.bold}Commits on origin/${branch} since ${last?.tag ?? 'beginning'}:${C.reset}`);
	if (commits.length === 0) {
		log(`    ${C.dim}(none)${C.reset}`);
	} else {
		for (const c of commits) {
			log(`    ${c.sha}  ${c.subject}`);
		}
	}

	const missingPRs = getMissingPRs(prs, branch, ghRepo).map((pr) => ({
		repo: ghRepo,
		branch,
		number: pr.number,
		title: pr.title,
	}));
	for (const pr of missingPRs) warn(`  MISSING: ${ghRepo} #${pr.number} on ${branch} — ${pr.title}`);
	if (!missingPRs.length) ok(`\n  Backport verification passed (${prs.length} PRs).`);
	return { prs, commits, missingPRs, lastTag: last?.tag ?? null };
}

// ── Semver helpers ────────────────────────────────────────────────────────────
// The CM slot must follow the version. `stable` is what GA clusters consume, so
// sending a prerelease there would put a beta in front of production traffic;
// prereleases belong in `next`. `override` forces the rare deliberate mismatch
// (validated upstream as 'stable' | 'next' | null).
function deriveVersionName(version, override) {
	return override ?? (semver.prerelease(version) ? 'next' : 'stable');
}

// Read version from a specific git ref's package.json. Without this we'd be
// reading the working-tree version, which is typically `main` and may be
// ahead of the release branch — producing a bogus "next version" target.
function readPackageVersion(ref) {
	if (!ref) return run('npm pkg get version').replace(/"/g, '').trim();
	const json = run(`git show ${ref}:package.json`);
	const m = json.match(/"version"\s*:\s*"([^"]+)"/);
	if (!m) throw new Error(`Could not parse version from ${ref}:package.json`);
	return m[1];
}

// ── Version bump + tag ────────────────────────────────────────────────────────
// Call with cwd on the repo root and release branch checked out.
// `targetVersion` is the explicit version to set (without leading 'v').
// Folds any already-staged changes (core submodule ref, synced deps) into the
// release commit.
function setVersion(repoLabel, targetVersion) {
	if (DRY_RUN) {
		ok(`  [dry-run] Would set ${repoLabel} version to v${targetVersion}`);
		return `v${targetVersion}`;
	}
	log(`\n  Setting ${repoLabel} version to v${targetVersion}...`);
	const newVersion = run(`npm version ${targetVersion} --no-git-tag-version`); // returns "v5.0.5"
	ok(`  Version set to ${newVersion}`);

	const toStage = ['package.json'];
	if (existsSync('package-lock.json')) toStage.push('package-lock.json');
	run(`git add ${toStage.join(' ')}`);

	run(`git commit -m "Release ${newVersion}"`);
	run(`git tag -a "${newVersion}" -m "Release ${newVersion}"`);
	ok(`  Tagged ${newVersion}`);
	return newVersion;
}

function buildSuccessResult({ target, coreVersion, proVersion, coreBumping, pushed, cmTriggered, dryRun }) {
	const reportedCoreVersion = dryRun && coreBumping ? `v${target}` : (coreVersion ?? null);
	return {
		ok: true,
		target: proVersion,
		coreVersion: reportedCoreVersion,
		proVersion,
		coreBumped: reportedCoreVersion !== null,
		pushed,
		cmTriggered,
		dryRun,
	};
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
	try {
		run('gh --version');
	} catch {
		die('gh CLI not found (https://cli.github.com)');
	}

	const harperProRoot = path.resolve(__dirname, '..');
	process.chdir(harperProRoot);
	const harperProOriginalBranch = run('git branch --show-current');

	log('\nInitializing core submodule if needed...');
	run('git submodule update --init core');

	const corePath = path.join(harperProRoot, 'core');
	process.chdir(corePath);
	const coreOriginalBranch = run('git branch --show-current');

	// ── Show status for both repos ─────────────────────────────────────────────
	const coreStatus = showRepoStatus({ absPath: corePath, name: 'harper (core)', branch: CORE_RELEASE_BRANCH });
	const proStatus = showRepoStatus({ absPath: harperProRoot, name: 'harper-pro' });
	const missingPRs = [...coreStatus.missingPRs, ...proStatus.missingPRs];

	if (missingPRs.length) {
		const message =
			'Missing milestone backports: ' + missingPRs.map((pr) => `${pr.repo} #${pr.number} (${pr.branch})`).join(', ');
		if (YES_MODE) die(message, 1, { missingPRs, pushed: false, cmTriggered: false }, true);
		warn('\n' + message);
		warn('Abort and resolve missing backports, or verify manually before confirming a release.');
	}

	// ── Compute target version (sync core and harper-pro) ──────────────────────
	// When both bump, sync to the highest of their natural next versions —
	// this catches up either repo that fell behind on a prior release.
	process.chdir(corePath);
	const coreCurrent = readPackageVersion(`origin/${CORE_RELEASE_BRANCH}`);
	process.chdir(harperProRoot);
	const proCurrent = readPackageVersion(`origin/${RELEASE_BRANCH}`);
	const coreBumping = coreStatus.commits.length > 0;
	const coreNext = semver.inc(coreCurrent, VERSION_BUMP);
	const proNext = semver.inc(proCurrent, VERSION_BUMP);
	const effectiveCore = coreBumping ? coreNext : coreCurrent;
	let target = semver.compare(effectiveCore, proNext) >= 0 ? effectiveCore : proNext;
	if (SET_VERSION) {
		target = semver.valid(SET_VERSION);
		if (!target) {
			die(`--set-version "${SET_VERSION}" is not a valid semver`);
		}
		if (semver.compare(target, coreCurrent) <= 0 || semver.compare(target, proCurrent) <= 0) {
			die(
				`--set-version "${SET_VERSION}" is not greater than current (core v${coreCurrent}, harper-pro v${proCurrent})`
			);
		}
		if (
			runSafe(`git rev-parse -q --verify "refs/tags/v${target}"`).code === 0 ||
			runSafe(`git -C "${corePath}" rev-parse -q --verify "refs/tags/v${target}"`).code === 0
		) {
			die(`--set-version "${SET_VERSION}": tag v${target} already exists`);
		}
	}

	info(`\n  Current:  core=v${coreCurrent}  harper-pro=v${proCurrent}`);
	info(`  Target:   v${target}`);
	if (coreBumping && coreNext !== target) {
		info(`            (core skipping v${coreNext} → v${target} to sync with harper-pro)`);
	}
	if (proNext !== target) {
		info(`            (harper-pro skipping v${proNext} → v${target} to sync with core)`);
	}

	// ── Steps 1–5: version bump, sync, tag, push (skipped in dry-run) ────────────
	let proVersion;
	let coreVersion = null;
	let pushed = false;
	let cmTriggered = false;
	if (DRY_RUN) {
		warn('\n[dry-run] Skipping version bump, sync, and push.');
		// Use a placeholder so Step 6 can still show the CM command it would run.
		proVersion = `v${target}`;
	} else {
		const confirm = YES_MODE
			? 'y'
			: await prompt(`\nProceed with version bump, sync, tag, and push for ${RELEASE_BRANCH}? [y/N]: `);
		if (confirm.toLowerCase() !== 'y') {
			warn('Aborted.');
			// Exit 0 (a human/--yes declined, nothing failed) but still emit a RESULT line
			// under --json — otherwise a caller parsing stdout for completion gets nothing.
			if (JSON_OUTPUT) writeResult(buildAbortedResult());
			return;
		}

		// ── Step 1: bump core (if it has new commits) ──────────────────────────
		process.chdir(corePath);
		run(`git checkout "${CORE_RELEASE_BRANCH}"`);
		run(`git merge --ff-only "origin/${CORE_RELEASE_BRANCH}"`);
		if (coreBumping) {
			coreVersion = setVersion('harper (core)', target);
		} else {
			info(
				`  No new commits on core's ${CORE_RELEASE_BRANCH} since ${coreStatus.lastTag} — skipping core version bump.`
			);
		}

		// ── Step 2: checkout harper-pro release branch ─────────────────────────
		process.chdir(harperProRoot);
		run(`git checkout "${RELEASE_BRANCH}"`);
		run(`git merge --ff-only "origin/${RELEASE_BRANCH}"`);

		// ── Step 3: sync core submodule + deps ─────────────────────────────────
		header('Syncing core submodule + dependencies');
		// sync-core.sh runs with NO_USE_GIT=true so it doesn't reset core to main per
		// .gitmodules — we manage the ref ourselves.
		log('Running build-tools/sync-core.sh...\n');
		try {
			execSync('./build-tools/sync-core.sh', {
				stdio: 'inherit',
				env: { ...process.env, NO_USE_GIT: 'true', IGNORE_PACKAGE_JSON_DIFF: 'true' },
			});
		} catch (e) {
			die(`sync-core.sh failed (exit ${e.status})`, e.status ?? 1);
		}

		// Stage core submodule ref + synced deps so they roll into the release commit
		const toStage = ['core', 'package.json'];
		if (existsSync('package-lock.json')) toStage.push('package-lock.json');
		run(`git add ${toStage.join(' ')}`);
		ok('\nSync staged.');

		// ── Step 4: bump harper-pro version ────────────────────────────────────
		proVersion = setVersion('harper-pro', target);

		// ── Step 5: push ───────────────────────────────────────────────────────
		// Push the branch and the specific tag explicitly. `npm version` creates a
		// lightweight tag, which `--follow-tags` ignores (it only pushes annotated
		// tags), so we name the tag in the refspec list.
		header('Pushing');
		if (coreVersion) {
			log(`  Pushing core ${CORE_RELEASE_BRANCH} ${coreVersion}...`);
			execSync(`git -C "${corePath}" push origin "${CORE_RELEASE_BRANCH}" "${coreVersion}"`, { stdio: 'inherit' });
		}
		log(`  Pushing harper-pro ${RELEASE_BRANCH} ${proVersion}...`);
		execSync(`git -C "${harperProRoot}" push origin "${RELEASE_BRANCH}" "${proVersion}"`, { stdio: 'inherit' });
		ok('\nTags pushed.');
		pushed = true;
	}

	// ── Step 6: trigger CM release-to-environments ─────────────────────────────
	header('Deploy to environments (Central Manager)');
	const plainVersion = proVersion.replace(/^v/, '');
	// The override-selection logic lives only in deriveVersionName, so this calls it for both
	// values rather than reimplementing `VERSION_NAME ?? derivedVersionName` inline here.
	const derivedVersionName = deriveVersionName(plainVersion, null);
	const versionName = deriveVersionName(plainVersion, VERSION_NAME);
	const cmCmd =
		`gh workflow run release-to-environments.yaml --repo HarperFast/central-manager ` +
		`-f version=${plainVersion} -f version_name=${versionName} -f update_environments=all`;
	log(`  Command: ${C.dim}${cmCmd}${C.reset}`);
	if (VERSION_NAME && VERSION_NAME !== derivedVersionName) {
		warn(`  version_name forced to "${VERSION_NAME}" via --version-name (derived would be "${derivedVersionName}").`);
	}
	// In --yes mode CM deploy is opt-in (pass --cm-trigger); interactive default-YES on EOF was a deploy footgun.
	const autoDeploy = resolveDeployAnswer({ cmTrigger: CM_TRIGGER, yesMode: YES_MODE });
	let deploy;
	if (autoDeploy !== null) {
		deploy = autoDeploy;
	} else {
		const promptText = CM_TRIGGER
			? `\n--cm-trigger requested — trigger CM release-to-environments (version_name=${versionName})? [Y/n]: `
			: `\nTrigger CM release-to-environments (version_name=${versionName})? [Y/n]: `;
		deploy = await prompt(promptText);
	}
	// Captured rather than thrown immediately: a requested-and-failed CM dispatch must still be
	// terminal (see below), but dying here would skip Step 7's branch restore, leaving a reused
	// dispatch worktree stuck on the release branch. die() is deferred until after Step 7.
	let cmFailure = null;
	if (deploy.toLowerCase() !== 'n') {
		log('\nTriggering CM workflow...');
		if (DRY_RUN) {
			ok('  [dry-run] Would run: ' + cmCmd);
		} else {
			try {
				execSync(cmCmd, { stdio: 'inherit' });
				cmTriggered = true;
				ok('  ✅ Workflow triggered — https://github.com/HarperFast/central-manager/actions');
			} catch (e) {
				err('  ❌ Failed to trigger workflow: ' + e.message);
				// A requested-but-failed dispatch must be terminal in the machine contract:
				// otherwise `--yes --cm-trigger --json` reports ok:true with cmTriggered:false,
				// and a dispatch caller can't distinguish "deploy skipped" from "deploy attempted
				// and failed" — it would mark a requested deployment successful when it never started.
				if (CM_TRIGGER) {
					cmFailure = buildCmFailureResult({ pushed, coreVersion, proVersion, error: e.message });
				}
			}
		}
	} else {
		warn(`  Skipped. Manually trigger release-to-environments with version_name=${versionName} when ready.`);
	}
	if (!cmFailure) ok('\n✅ Done.');

	// ── Step 7: offer to return to original branches ───────────────────────────
	// Always runs, even after a requested CM-trigger failure above, so a reused dispatch
	// worktree isn't left checked out on the release branch.
	process.chdir(corePath);
	if (coreOriginalBranch && coreOriginalBranch !== CORE_RELEASE_BRANCH) {
		const back = YES_MODE ? 'y' : await prompt(`\nReturn core to "${coreOriginalBranch}"? [Y/n]: `);
		if (back.toLowerCase() !== 'n') run(`git checkout "${coreOriginalBranch}"`);
	}
	process.chdir(harperProRoot);
	if (harperProOriginalBranch && harperProOriginalBranch !== RELEASE_BRANCH) {
		const back = YES_MODE ? 'y' : await prompt(`Return harper-pro to "${harperProOriginalBranch}"? [Y/n]: `);
		if (back.toLowerCase() !== 'n') run(`git checkout "${harperProOriginalBranch}"`);
	}

	if (cmFailure) {
		die(cmFailure.message, 1, cmFailure.extra);
	}

	if (JSON_OUTPUT) {
		writeResult(
			buildSuccessResult({
				target,
				coreVersion,
				proVersion,
				coreBumping,
				pushed,
				cmTriggered,
				dryRun: DRY_RUN,
			})
		);
	}
}

if (require.main === module) {
	main().catch((e) => {
		die('Fatal: ' + (e?.message ?? String(e)));
	});
}

module.exports = {
	milestoneTargetsRelease,
	isPRPresent,
	getArg,
	deriveVersionName,
	resolveDeployAnswer,
	buildAbortedResult,
	buildCmFailureResult,
	buildSuccessResult,
	writeResult,
};
