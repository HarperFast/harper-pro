#!/usr/bin/env node
'use strict';
/**
 * Applies patch-labeled PRs to the release branch across core and harper-pro,
 * then syncs the core submodule and its dependencies.
 *
 * Order:
 *   1. Cherry-pick patch PRs onto core (HarperFast/harper) release branch
 *   2. Bump core version + tag
 *   3. Cherry-pick patch PRs onto harper-pro release branch
 *   4. Run build-tools/sync-core.sh (skipping submodule update — core stays on
 *      the release branch we just patched)
 *   5. Bump harper-pro version + tag (commit includes core ref + synced deps)
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
 *
 * AI conflict resolution:
 *   Requires the Gemini CLI: https://github.com/google-gemini/gemini-cli
 *   Install and authenticate, then `gemini` must be on your PATH.
 */

const { execSync, spawnSync } = require('child_process');
const { existsSync, readFileSync, writeFileSync } = require('fs');
const path = require('path');
const readline = require('readline');

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
const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m' };
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

// ── Gemini CLI detection ──────────────────────────────────────────────────────
const GEMINI_AVAILABLE = runSafe('which gemini').code === 0;
if (GEMINI_AVAILABLE) {
  info('AI conflict resolution enabled (Gemini CLI).');
} else {
  warn('gemini CLI not found — AI conflict resolution disabled.');
  warn('  Install: https://github.com/google-gemini/gemini-cli');
}

// ── User prompt ───────────────────────────────────────────────────────────────
async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

// ── Git helpers ───────────────────────────────────────────────────────────────
function isMergeCommit(sha) {
  const out = run(`git cat-file -p "${sha}"`);
  return out.split('\n').filter((l) => l.startsWith('parent ')).length > 1;
}

function getConflictedFiles() {
  const r = runSafe('git diff --name-only --diff-filter=U');
  return r.out ? r.out.split('\n').filter(Boolean) : [];
}

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

// Returns the ordered list of SHAs to cherry-pick for a PR, based on merge strategy:
//   Merge commit  → [{sha, flag:'-m 1 '}]          (single pick, combined diff)
//   Squash merge  → [{sha, flag:''}]                (single pick)
//   Rebase merge  → [{sha:oldest,flag:''}, ..., {sha:newest,flag:''}]  (N picks)
// Rebase-merged PRs report mergeCommit as the LAST commit; earlier commits are
// reconstructed by walking back sha~(N-1)..sha using the commit count from the API.
function getPRPickList(pr) {
  const sha = pr.mergeCommit.oid;
  if (isMergeCommit(sha)) return [{ sha, flag: '-m 1 ' }];
  const count = getPRCommitCount(pr);
  if (count <= 1) return [{ sha, flag: '' }];
  // Rebase merge: reconstruct oldest→newest
  const list = [];
  for (let i = count - 1; i >= 0; i--) {
    list.push({ sha: run(`git rev-parse "${sha}~${i}"`), flag: '' });
  }
  return list;
}

// Check if a commit's patch is already present in the release branch.
// git cherry compares patch-ids (content, not SHA), so it correctly identifies
// commits that were cherry-picked into the release branch with a different SHA.
// For rebase-merged PRs, ALL commits must be present to consider the PR applied.
// Merge commits are not checked here (too complex); cherry-pick detects them live.
function isAlreadyApplied(pr) {
  const sha = pr.mergeCommit.oid;
  if (isMergeCommit(sha)) return false; // checked live by cherry-pick
  const pickList = getPRPickList(pr);
  return pickList.every(({ sha: s }) => {
    const r = runSafe(`git cherry "origin/${RELEASE_BRANCH}" "${s}" "${s}^"`);
    return r.code === 0 && r.out.startsWith('-');
  });
}

// ── GitHub helpers ────────────────────────────────────────────────────────────
function getPatchPRs(ghRepo) {
  const json = run(
    `gh pr list --repo "${ghRepo}" --label "${LABEL}" --state merged --base "${SOURCE_BRANCH}" ` +
      `--json number,title,mergeCommit,body --limit 200`
  );
  const prs = JSON.parse(json).filter((pr) => pr.mergeCommit?.oid);
  // Tag each PR with its repo so helpers can make follow-up API calls if needed
  prs.forEach((pr) => { pr._ghRepo = ghRepo; });
  return prs;
}

// Returns the number of commits in a PR — used only for single-parent merge commits
// to distinguish squash (1 commit) from rebase (N commits). Result is cached on pr.
function getPRCommitCount(pr) {
  if (pr._commitCount !== undefined) return pr._commitCount;
  try {
    const json = run(`gh pr view ${pr.number} --repo "${pr._ghRepo}" --json commits`);
    pr._commitCount = JSON.parse(json).commits?.length ?? 1;
  } catch {
    pr._commitCount = 1; // assume squash on error
  }
  return pr._commitCount;
}

// ── Gemini conflict resolution ────────────────────────────────────────────────
function resolveWithGemini(pr, conflictedFiles) {
  if (!GEMINI_AVAILABLE) return { resolved: [], unresolvable: conflictedFiles };

  log('\n  Asking Gemini to resolve conflicts...');

  const filesBlock = conflictedFiles
    .map((f) => `### File: ${f}\n\`\`\`\n${readFileSync(f, 'utf8')}\n\`\`\``)
    .join('\n\n');

  const promptText = `You are a senior engineer helping resolve git cherry-pick merge conflicts.

Context: PR #${pr.number} "${pr.title}" is being cherry-picked onto a release branch.

PR description:
${pr.body?.trim() || '(none)'}

The following files have conflict markers (<<<<<<<, =======, >>>>>>>).
For each file, decide the correct resolution — usually accepting the incoming change
(HEAD is the release branch; the >>>>>>> side is the patch being applied).

Respond with valid JSON only, shaped like:
{
  "files": [
    { "path": "relative/path/file.js", "status": "resolved", "content": "<full file content>" },
    { "path": "relative/path/other.js", "status": "unresolvable", "reason": "<why>" }
  ]
}

${filesBlock}`;

  // -p '' triggers headless mode; prompt text goes via stdin (appended per CLI docs)
  const r = spawnSync('gemini', ['-p', ''], {
    input: promptText,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024,
  });

  if (r.status !== 0) {
    warn(`  Gemini CLI error: ${r.stderr || r.stdout}`);
    return { resolved: [], unresolvable: conflictedFiles };
  }

  const jsonText = r.stdout.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    warn('  Gemini returned unparseable JSON — falling back to manual resolution.');
    return { resolved: [], unresolvable: conflictedFiles };
  }

  const resolved = [];
  const unresolvable = [];
  for (const file of parsed.files ?? []) {
    if (file.status === 'resolved') {
      writeFileSync(file.path, file.content);
      run(`git add "${file.path}"`);
      ok(`  Auto-resolved: ${file.path}`);
      resolved.push(file.path);
    } else {
      warn(`  Unresolvable: ${file.path} — ${file.reason}`);
      unresolvable.push(file.path);
    }
  }
  return { resolved, unresolvable };
}

// ── Cherry-pick helpers ───────────────────────────────────────────────────────

// Pick a single SHA; handles conflicts interactively. Returns 'applied' | 'already-present' | 'skipped'.
async function pickOneSha(sha, flag, pr) {
  const pickCmd = `git cherry-pick ${flag}${sha}`;
  log(`  Commit: ${sha.slice(0, 8)}  (${pickCmd})`);

  if (DRY_RUN) { ok('  [dry-run] Would apply.'); return 'applied'; }

  const r = runSafe(pickCmd);
  if (r.code === 0) { ok('  Applied cleanly.'); return 'applied'; }

  if (r.errText.includes('nothing to commit') || r.out.includes('nothing to commit')) {
    runSafe('git cherry-pick --skip');
    warn('  Changes already present — skipped.');
    return 'already-present';
  }

  err('  Conflict detected!');
  const conflicted = getConflictedFiles();
  log(`  Conflicted: ${conflicted.join(', ')}`);

  warn('\n  Options:');
  warn('    t — accept theirs (incoming patch) for all conflicted files');
  warn('    o — accept ours (release branch) for all conflicted files');
  if (GEMINI_AVAILABLE) warn('    g — ask Gemini to resolve');
  warn('    r — I resolved manually, continue cherry-pick');
  warn('    s — skip this PR');
  warn('    q — quit');

  const menuChoices = GEMINI_AVAILABLE ? '[t/o/g/r/s/q]' : '[t/o/r/s/q]';

  while (true) {
    const ans = await prompt(`  Choice ${menuChoices}: `);
    if (ans === 'q') { runSafe('git cherry-pick --abort'); err('Aborted.'); process.exit(1); }
    if (ans === 's') { runSafe('git cherry-pick --abort'); warn(`  Skipped PR #${pr.number}.`); return 'skipped'; }
    if (ans === 't' || ans === 'o') {
      const strategy = ans === 't' ? 'theirs' : 'ours';
      const current = getConflictedFiles();
      for (const f of current) { run(`git checkout --${strategy} "${f}"`); run(`git add "${f}"`); }
      ok(`  Accepted ${strategy} for: ${current.join(', ')}`);
      const cont = runSafe('git cherry-pick --continue --no-edit');
      if (cont.code === 0) { ok('  Cherry-pick complete.'); return 'applied'; }
      const still = getConflictedFiles();
      if (still.length > 0) { warn(`  Still conflicted after --${strategy}: ${still.join(', ')}`); continue; }
      err('  --continue failed: ' + cont.errText);
    }
    if (ans === 'g' && GEMINI_AVAILABLE) {
      const { resolved, unresolvable } = resolveWithGemini(pr, getConflictedFiles());
      if (unresolvable.length === 0 && resolved.length > 0) {
        const cont = runSafe('git cherry-pick --continue --no-edit');
        if (cont.code === 0) { ok('  All conflicts resolved by Gemini. Cherry-pick complete.'); return 'applied'; }
        err('  --continue failed after Gemini resolution: ' + cont.errText);
      }
      if (unresolvable.length > 0) warn(`  Gemini could not resolve: ${unresolvable.join(', ')}`);
    }
    if (ans === 'r') {
      const remaining = getConflictedFiles();
      if (remaining.length > 0) { warn(`  Still conflicted: ${remaining.join(', ')}`); continue; }
      runSafe('git add -A');
      const cont = runSafe('git cherry-pick --continue --no-edit');
      if (cont.code === 0) { ok('  Cherry-pick complete.'); return 'applied'; }
      err('  Continue failed: ' + cont.errText);
    }
  }
}

// Cherry-pick all commits that make up a PR (handles merge / squash / rebase strategies).
async function cherryPickPR(pr) {
  const pickList = getPRPickList(pr);
  if (pickList.length > 1) {
    log(`  Rebase-merged PR: picking ${pickList.length} commits individually`);
  }
  let anyApplied = false;
  for (const { sha, flag } of pickList) {
    const outcome = await pickOneSha(sha, flag, pr);
    if (outcome === 'applied') { anyApplied = true; }
    else if (outcome === 'skipped') { return 'skipped'; }
    // 'already-present' → continue to next commit
  }
  return anyApplied ? 'applied' : 'already-present';
}

// ── Version bump + tag ────────────────────────────────────────────────────────
// Call this while cwd is the repo root and the release branch is checked out.
// Any already-staged changes (e.g. core submodule ref, synced deps) are folded
// into the release commit automatically.
function bumpVersion(repoLabel) {
  if (DRY_RUN) {
    ok(`  [dry-run] Would run: npm version ${VERSION_BUMP} and tag`);
    return null;
  }
  log(`\n  Bumping ${VERSION_BUMP} version in ${repoLabel}...`);
  const newVersion = run(`npm version ${VERSION_BUMP} --no-git-tag-version`).trim(); // e.g. "v5.0.5"
  ok(`  Version bumped to ${newVersion}`);

  // Stage the version change (plus any previously staged files like core ref or deps)
  const toStage = ['package.json'];
  if (existsSync('package-lock.json')) toStage.push('package-lock.json');
  run(`git add ${toStage.join(' ')}`);

  run(`git commit -m "Release ${newVersion}"`);
  run(`git tag "${newVersion}"`);
  ok(`  Tagged ${newVersion}`);
  return newVersion;
}

// ── Patch one repo ────────────────────────────────────────────────────────────
// Checks out the release branch, cherry-picks labeled PRs, and returns results.
// Leaves cwd at absPath on the release branch (or original branch if no changes).
async function patchRepo({ absPath, name }) {
  header(`Patching ${name}`);
  process.chdir(absPath);

  const ghRepo = detectGhRepo();
  info(`  GitHub repo: ${ghRepo}`);

  if (!hasBranch(RELEASE_BRANCH)) {
    err(`  Release branch "${RELEASE_BRANCH}" not found in ${name}.`);
    process.exit(1);
  }

  log(`  Fetching from origin...`);
  run('git fetch origin');

  log(`  Looking for PRs labeled "${LABEL}" merged into "${SOURCE_BRANCH}"...`);
  const prs = getPatchPRs(ghRepo);

  if (prs.length === 0) {
    warn(`  No merged PRs with label "${LABEL}" found.`);
    return { applied: [] };
  }

  // Pre-check which PRs are already in the release branch (by patch content, not SHA)
  log(`  Checking which PRs are already in ${RELEASE_BRANCH}...`);
  const newPRs = [];
  const preApplied = [];
  for (const pr of prs) {
    if (isAlreadyApplied(pr)) {
      preApplied.push(pr);
    } else {
      newPRs.push(pr);
    }
  }
  // Apply oldest PR first: reduces ordering issues where a newer rebase-merged PR's
  // commit range overlaps an older PR's commits (the older PR will be picked first,
  // so the overlapping commits are already-present when the newer PR is processed).
  newPRs.sort((a, b) => a.number - b.number);

  log('');
  if (preApplied.length) {
    log(`  Already in ${RELEASE_BRANCH}:`);
    for (const pr of preApplied) {
      log(`    ${C.yellow}✓${C.reset} #${pr.number.toString().padEnd(5)} ${pr.mergeCommit.oid.slice(0, 8)}  ${pr.title}`);
    }
  }
  if (newPRs.length) {
    log(`  New (will be applied):`);
    for (const pr of newPRs) {
      log(`    ${C.green}+${C.reset} #${pr.number.toString().padEnd(5)} ${pr.mergeCommit.oid.slice(0, 8)}  ${pr.title}`);
    }
  }

  if (newPRs.length === 0) {
    ok(`  All ${prs.length} PR(s) already present in ${RELEASE_BRANCH} — nothing to apply.`);
    return { applied: [], 'already-present': preApplied };
  }

  if (!DRY_RUN) {
    const confirm = await prompt(`\n  Apply ${newPRs.length} new PR(s) onto ${RELEASE_BRANCH}? [Y/n]: `);
    if (confirm.toLowerCase() === 'n') { warn('  Skipped.'); return { applied: [], 'already-present': preApplied }; }
  }

  log(`\n  Checking out ${RELEASE_BRANCH}...`);
  if (!DRY_RUN) run(`git checkout "${RELEASE_BRANCH}"`);

  const results = { applied: [], 'already-present': preApplied, skipped: [] };

  for (const pr of newPRs) {
    log(`\n  ${'─'.repeat(56)}`);
    log(`  PR #${pr.number}: ${pr.title}`);
    const outcome = await cherryPickPR(pr);
    if (outcome === 'already-present') {
      results['already-present'].push(pr);
    } else {
      (results[outcome] = results[outcome] ?? []).push(pr);
    }
  }

  log(`\n  ${'═'.repeat(56)}`);
  if (results.applied?.length)             ok(`  Applied:         ${results.applied.map((p) => '#' + p.number).join(', ')}`);
  if (results['already-present']?.length)  log(`  Already present: ${results['already-present'].map((p) => '#' + p.number).join(', ')}`);
  if (results.skipped?.length)            warn(`  Skipped:         ${results.skipped.map((p) => '#' + p.number).join(', ')}`);

  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  try { run('gh --version'); } catch { err('gh CLI not found (https://cli.github.com)'); process.exit(1); }

  const harperProRoot = path.resolve(__dirname, '..');
  process.chdir(harperProRoot);

  const harperProOriginalBranch = run('git branch --show-current');

  log('\nInitializing core submodule if needed...');
  run('git submodule update --init core');

  const corePath = path.join(harperProRoot, 'core');

  // ── Step 1: patch core ─────────────────────────────────────────────────────
  process.chdir(corePath);
  const coreOriginalBranch = run('git branch --show-current');

  const coreResults = await patchRepo({ absPath: corePath, name: 'harper (core)' });

  // Bump core version if any PRs were applied (leaves core on release branch)
  let coreVersion = null;
  if (coreResults.applied?.length || DRY_RUN) {
    process.chdir(corePath);
    coreVersion = bumpVersion('harper (core)');
    if (!DRY_RUN && coreVersion) {
      log(`\n  Ready to push core: git -C core push origin ${RELEASE_BRANCH} --follow-tags`);
    }
  }

  // ── Step 2: patch harper-pro ───────────────────────────────────────────────
  process.chdir(harperProRoot);
  // Checkout harper-pro release branch before patching
  if (!DRY_RUN) run(`git checkout "${RELEASE_BRANCH}"`);
  await patchRepo({ absPath: harperProRoot, name: 'harper-pro' });

  // ── Step 3: sync core submodule + deps ─────────────────────────────────────
  header('Syncing core submodule + dependencies');
  process.chdir(harperProRoot);

  if (DRY_RUN) {
    ok('[dry-run] Would sync core submodule to release branch and run sync-core.sh');
  } else {
    // Point core submodule at the release branch (not main) before syncing deps
    run(`git -C core checkout "${RELEASE_BRANCH}"`);

    // Run sync-core.sh with NO_USE_GIT=true so it skips `git submodule update --remote`
    // (which would reset core back to main per .gitmodules). We manage the ref ourselves.
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
  }

  // ── Step 4: bump harper-pro version ───────────────────────────────────────
  // Always bump: every patch release bumps harper-pro regardless of whether
  // it had its own labeled PRs (core patches + sync always constitute a change).
  process.chdir(harperProRoot);
  const proVersion = bumpVersion('harper-pro');

  // ── Done ───────────────────────────────────────────────────────────────────
  header('All done');
  if (!DRY_RUN) {
    log('Push commands:');
    if (coreVersion) log(`  git -C core push origin ${RELEASE_BRANCH} --follow-tags`);
    log(`  git push origin ${RELEASE_BRANCH} --follow-tags`);

    // Offer to return to original branches
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
}

main().catch((e) => { err('Fatal: ' + e.message); process.exit(1); });
