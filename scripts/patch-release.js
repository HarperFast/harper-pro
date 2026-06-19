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
 *        - labeled PRs merged into main since the last release tag
 *        - commits on origin/<RELEASE_BRANCH> since the last release tag
 *      (so the user can visually verify they match — flag missing cherry-picks)
 *   2. After confirmation:
 *        - bump core version + tag (if core has new commits)
 *        - run build-tools/sync-core.sh to point harper-pro at the bumped core
 *        - bump harper-pro version + tag
 *        - push both repos with --follow-tags
 *
 * Usage:
 *   node scripts/patch-release.js [options]
 *
 * Options:
 *   --branch <name>   Release branch (default: v5.0)
 *   --source <name>   Source branch (default: main)
 *   --label <name>    PR label to filter on (default: patch)
 *   --bump <type>     npm version bump: patch|minor|major (default: patch)
 *   --dry-run         Preview without making changes
 */

const { execSync, spawnSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');
const readline = require('readline');
const semver = require('semver');

// ── Args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const RELEASE_BRANCH = getArg('--branch', 'v5.0');
const SOURCE_BRANCH = getArg('--source', 'main');
const LABEL = getArg('--label', 'patch');
const VERSION_BUMP = getArg('--bump', 'patch'); // patch | minor | major

function getArg(flag, def) {
	const i = argv.indexOf(flag);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}

// ── Logging ───────────────────────────────────────────────────────────────────
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

function hasBranch(branch) {
	return (
		runSafe(`git show-ref --verify "refs/heads/${branch}"`).code === 0 ||
		runSafe(`git show-ref --verify "refs/remotes/origin/${branch}"`).code === 0
	);
}

// Most recent semver tag reachable from origin/RELEASE_BRANCH, with its commit date.
function getLastRelease() {
	const tagR = runSafe(`git describe --tags --abbrev=0 --match 'v*.*.*' "origin/${RELEASE_BRANCH}"`);
	if (tagR.code !== 0 || !tagR.out) return null;
	const tag = tagR.out;
	const dateR = runSafe(`git log -1 --format=%aI "${tag}"`);
	if (dateR.code !== 0 || !dateR.out) return null;
	return { tag, date: dateR.out };
}

function getPatchPRs(ghRepo, sinceDate) {
	const json = run(
		`gh pr list --repo "${ghRepo}" --label "${LABEL}" --state merged --base "${SOURCE_BRANCH}" ` +
			`--json number,title,mergeCommit,mergedAt --limit 200`
	);
	let prs = JSON.parse(json).filter((pr) => pr.mergeCommit?.oid);
	if (sinceDate) prs = prs.filter((pr) => pr.mergedAt && pr.mergedAt > sinceDate);
	return prs;
}

function getReleaseBranchCommits(lastTag) {
	const range = lastTag ? `${lastTag}..origin/${RELEASE_BRANCH}` : `origin/${RELEASE_BRANCH}`;
	const r = runSafe(`git log ${range} --format='%h%x09%s'`);
	if (r.code !== 0 || !r.out) return [];
	return r.out
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [sha, ...rest] = line.split('\t');
			return { sha, subject: rest.join('\t') };
		});
}

// ── Per-repo status display ───────────────────────────────────────────────────
function showRepoStatus({ absPath, name }) {
	header(name);
	process.chdir(absPath);
	const ghRepo = detectGhRepo();
	info(`  GitHub repo: ${ghRepo}`);

	if (!hasBranch(RELEASE_BRANCH)) {
		err(`  Release branch "${RELEASE_BRANCH}" not found.`);
		process.exit(1);
	}

	log('  Fetching from origin...');
	run('git fetch origin --tags');

	const last = getLastRelease();
	if (last) info(`  Last release: ${last.tag} (${last.date})`);
	else warn(`  No prior semver tag on ${RELEASE_BRANCH}.`);

	const prs = getPatchPRs(ghRepo, last?.date);
	prs.sort((a, b) => a.number - b.number);

	const commits = getReleaseBranchCommits(last?.tag);

	log(`\n  ${C.bold}Labeled PRs merged into ${SOURCE_BRANCH} since ${last?.tag ?? 'beginning'}:${C.reset}`);
	if (prs.length === 0) {
		log(`    ${C.dim}(none)${C.reset}`);
	} else {
		for (const pr of prs) {
			log(`    #${String(pr.number).padEnd(5)} ${pr.mergeCommit.oid.slice(0, 8)}  ${pr.title}`);
		}
	}

	log(`\n  ${C.bold}Commits on origin/${RELEASE_BRANCH} since ${last?.tag ?? 'beginning'}:${C.reset}`);
	if (commits.length === 0) {
		log(`    ${C.dim}(none)${C.reset}`);
	} else {
		for (const c of commits) {
			log(`    ${c.sha}  ${c.subject}`);
		}
	}

	return { prs, commits, lastTag: last?.tag ?? null };
}

// ── Semver helpers ────────────────────────────────────────────────────────────
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
	run(`git tag "${newVersion}"`);
	ok(`  Tagged ${newVersion}`);
	return newVersion;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
	try {
		run('gh --version');
	} catch {
		err('gh CLI not found (https://cli.github.com)');
		process.exit(1);
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
	const coreStatus = showRepoStatus({ absPath: corePath, name: 'harper (core)' });
	showRepoStatus({ absPath: harperProRoot, name: 'harper-pro' });

	log('');
	log(`${C.bold}Visual check:${C.reset} verify each labeled PR has a corresponding commit on ${RELEASE_BRANCH}.`);
	log(
		'If any PRs are missing commits, a cherry-pick may have failed or conflicted — abort and resolve before proceeding.'
	);

	// ── Compute target version (sync core and harper-pro) ──────────────────────
	// When both bump, sync to the highest of their natural next versions —
	// this catches up either repo that fell behind on a prior release.
	process.chdir(corePath);
	const coreCurrent = readPackageVersion(`origin/${RELEASE_BRANCH}`);
	process.chdir(harperProRoot);
	const proCurrent = readPackageVersion(`origin/${RELEASE_BRANCH}`);
	const coreBumping = coreStatus.commits.length > 0;
	const coreNext = semver.inc(coreCurrent, VERSION_BUMP);
	const proNext = semver.inc(proCurrent, VERSION_BUMP);
	const effectiveCore = coreBumping ? coreNext : coreCurrent;
	const target = semver.compare(effectiveCore, proNext) >= 0 ? effectiveCore : proNext;

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
	if (DRY_RUN) {
		warn('\n[dry-run] Skipping version bump, sync, and push.');
		// Use a placeholder so Step 6 can still show the CM command it would run.
		proVersion = `v${target}`;
	} else {
		const confirm = await prompt(`\nProceed with version bump, sync, tag, and push for ${RELEASE_BRANCH}? [y/N]: `);
		if (confirm.toLowerCase() !== 'y') {
			warn('Aborted.');
			return;
		}

		// ── Step 1: bump core (if it has new commits) ──────────────────────────
		process.chdir(corePath);
		run(`git checkout "${RELEASE_BRANCH}"`);
		run(`git merge --ff-only "origin/${RELEASE_BRANCH}"`);
		if (coreBumping) {
			coreVersion = setVersion('harper (core)', target);
		} else {
			info(`  No new commits on core's ${RELEASE_BRANCH} since ${coreStatus.lastTag} — skipping core version bump.`);
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
			err(`sync-core.sh failed (exit ${e.status})`);
			process.exit(e.status ?? 1);
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
			log(`  Pushing core ${RELEASE_BRANCH} ${coreVersion}...`);
			execSync(`git -C "${corePath}" push origin "${RELEASE_BRANCH}" "${coreVersion}"`, { stdio: 'inherit' });
		}
		log(`  Pushing harper-pro ${RELEASE_BRANCH} ${proVersion}...`);
		execSync(`git -C "${harperProRoot}" push origin "${RELEASE_BRANCH}" "${proVersion}"`, { stdio: 'inherit' });
		ok('\nTags pushed.');
	}

	// ── Step 6: trigger CM release-to-environments ─────────────────────────────
	header('Deploy to environments (Central Manager)');
	const plainVersion = proVersion.replace(/^v/, '');
	const cmCmd =
		`gh workflow run release-to-environments.yaml --repo HarperFast/central-manager ` +
		`-f version=${plainVersion} -f version_name=stable -f update_environments=all`;
	log(`  Command: ${C.dim}${cmCmd}${C.reset}`);
	const deploy = await prompt(`\nTrigger CM release-to-environments (version_name=stable)? [Y/n]: `);
	if (deploy.toLowerCase() !== 'n') {
		log('\nTriggering CM workflow...');
		if (DRY_RUN) {
			ok('  [dry-run] Would run: ' + cmCmd);
		} else {
			try {
				execSync(cmCmd, { stdio: 'inherit' });
				ok('  ✅ Workflow triggered — https://github.com/HarperFast/central-manager/actions');
			} catch (e) {
				err('  ❌ Failed to trigger workflow: ' + e.message);
			}
		}
	} else {
		warn('  Skipped. Manually trigger release-to-environments with version_name=stable when ready.');
	}
	ok('\n✅ Done.');

	// ── Step 7: offer to return to original branches ───────────────────────────
	process.chdir(corePath);
	if (coreOriginalBranch && coreOriginalBranch !== RELEASE_BRANCH) {
		const back = await prompt(`\nReturn core to "${coreOriginalBranch}"? [Y/n]: `);
		if (back.toLowerCase() !== 'n') run(`git checkout "${coreOriginalBranch}"`);
	}
	process.chdir(harperProRoot);
	if (harperProOriginalBranch && harperProOriginalBranch !== RELEASE_BRANCH) {
		const back = await prompt(`Return harper-pro to "${harperProOriginalBranch}"? [Y/n]: `);
		if (back.toLowerCase() !== 'n') run(`git checkout "${harperProOriginalBranch}"`);
	}
}

main().catch((e) => {
	err('Fatal: ' + e.message);
	process.exit(1);
});
