#!/usr/bin/env node
'use strict';
/**
 * Cherry-picks patch-labeled PRs from main onto a release branch.
 *
 * Usage:
 *   node scripts/patch-release.js [options]
 *
 * Options:
 *   --branch <name>   Release branch to patch (default: v5.0)
 *   --source <name>   Source branch to pull patches from (default: main)
 *   --label <name>    PR label to filter on (default: patch)
 *   --dry-run         Show what would be done without making changes
 *
 * AI conflict resolution:
 *   Set ANTHROPIC_API_KEY in your environment and ensure @anthropic-ai/sdk is
 *   installed (npm install -g @anthropic-ai/sdk) to enable Claude-assisted
 *   conflict resolution.
 */

const { execSync, spawnSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');
const readline = require('readline');

// ── Args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const RELEASE_BRANCH = getArg('--branch', 'v5.0');
const SOURCE_BRANCH = getArg('--source', 'main');
const LABEL = getArg('--label', 'patch');

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

// ── Shell helpers ─────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

function runSafe(cmd) {
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  return { out: r.stdout.trim(), errText: r.stderr.trim(), code: r.status ?? 1 };
}

// ── Anthropic SDK (optional) ──────────────────────────────────────────────────
let anthropicClient = null;
try {
  // Support both locally installed and globally installed SDK
  const Anthropic = require('@anthropic-ai/sdk');
  const Cls = Anthropic.default ?? Anthropic;
  if (process.env.ANTHROPIC_API_KEY) {
    anthropicClient = new Cls();
    info('AI conflict resolution enabled.');
  } else {
    warn('ANTHROPIC_API_KEY not set — AI conflict resolution disabled.');
  }
} catch {
  warn('@anthropic-ai/sdk not found — AI conflict resolution disabled.');
  warn('  To enable: npm install -g @anthropic-ai/sdk  (and set ANTHROPIC_API_KEY)');
}

// ── Git helpers ───────────────────────────────────────────────────────────────
function isMergeCommit(sha) {
  const info = run(`git cat-file -p "${sha}"`);
  return info.split('\n').filter((l) => l.startsWith('parent ')).length > 1;
}

function getConflictedFiles() {
  const r = runSafe('git diff --name-only --diff-filter=U');
  return r.out ? r.out.split('\n').filter(Boolean) : [];
}

// ── GitHub helpers ────────────────────────────────────────────────────────────
function getPatchPRs() {
  const json = run(
    `gh pr list --label "${LABEL}" --state merged --base "${SOURCE_BRANCH}" ` +
      `--json number,title,mergeCommit,body --limit 200`
  );
  return JSON.parse(json).filter((pr) => pr.mergeCommit?.oid);
}

// ── User prompt ───────────────────────────────────────────────────────────────
async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

// ── AI conflict resolution ────────────────────────────────────────────────────
async function resolveWithAI(pr, conflictedFiles) {
  if (!anthropicClient) return { resolved: [], unresolvable: conflictedFiles };

  log('\n  Asking Claude to resolve conflicts...');

  const filesBlock = conflictedFiles
    .map((f) => `### File: ${f}\n\`\`\`\n${readFileSync(f, 'utf8')}\n\`\`\``)
    .join('\n\n');

  const userMessage = `You are a senior engineer helping resolve git cherry-pick merge conflicts.

Context: PR #${pr.number} "${pr.title}" is being cherry-picked onto a release branch.

PR description:
${pr.body?.trim() || '(none)'}

The following files have conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`).
For each file, decide the correct resolution — usually accepting the incoming change
(HEAD changes are the release branch; the incoming \`>>>>>>>\` side is the patch being applied).

Respond with valid JSON only, shaped like:
{
  "files": [
    {
      "path": "relative/path/to/file.js",
      "status": "resolved",
      "content": "<full resolved file content as a string>"
    },
    {
      "path": "relative/path/to/other.js",
      "status": "unresolvable",
      "reason": "<brief explanation of why>"
    }
  ]
}

${filesBlock}`;

  let responseText;
  try {
    const message = await anthropicClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16384,
      messages: [{ role: 'user', content: userMessage }],
    });
    responseText = message.content[0].text;
  } catch (e) {
    warn(`  Claude API error: ${e.message}`);
    return { resolved: [], unresolvable: conflictedFiles };
  }

  // Parse JSON — strip markdown fences if present
  const jsonText = responseText.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    warn('  Claude returned unparseable JSON — falling back to manual resolution.');
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

// ── Cherry-pick a single PR ───────────────────────────────────────────────────
async function cherryPickPR(pr) {
  const sha = pr.mergeCommit.oid;
  const mergeFlag = isMergeCommit(sha) ? '-m 1 ' : '';
  const pickCmd = `git cherry-pick ${mergeFlag}${sha}`;

  log(`  Commit: ${sha.slice(0, 8)}  cmd: ${pickCmd}`);

  if (DRY_RUN) {
    ok('  [dry-run] Would apply.');
    return 'applied';
  }

  const r = runSafe(pickCmd);

  if (r.code === 0) {
    ok('  Applied cleanly.');
    return 'applied';
  }

  // Already applied (empty cherry-pick)
  if (r.errText.includes('nothing to commit') || r.errText.includes('allow-empty') || r.out.includes('nothing to commit')) {
    runSafe('git cherry-pick --skip');
    warn('  Changes already present on release branch — skipped.');
    return 'already-present';
  }

  // Conflict
  err(`  Conflict detected!`);
  const conflicted = getConflictedFiles();
  log(`  Conflicted: ${conflicted.join(', ')}`);

  const { resolved, unresolvable } = await resolveWithAI(pr, conflicted);

  if (unresolvable.length === 0 && resolved.length > 0) {
    // All conflicts resolved by AI
    const cont = runSafe('git cherry-pick --continue --no-edit');
    if (cont.code === 0) {
      ok('  All conflicts resolved by AI. Cherry-pick complete.');
      return 'applied';
    }
    err('  --continue failed after AI resolution: ' + cont.errText);
  }

  // Manual intervention required
  if (unresolvable.length > 0) {
    warn(`\n  ${unresolvable.length} file(s) need manual resolution:`);
    unresolvable.forEach((f) => warn(`    ${f}`));
  }

  log('');
  warn('  Options:');
  warn('    r — I have resolved all conflicts manually, continue the cherry-pick');
  warn('    s — Skip this PR (abort cherry-pick)');
  warn('    q — Quit');

  while (true) {
    const ans = await prompt('  Choice [r/s/q]: ');
    if (ans === 'q') {
      runSafe('git cherry-pick --abort');
      err('Aborted.');
      process.exit(1);
    }
    if (ans === 's') {
      runSafe('git cherry-pick --abort');
      warn(`  Skipped PR #${pr.number}.`);
      return 'skipped';
    }
    if (ans === 'r') {
      const remaining = getConflictedFiles();
      if (remaining.length > 0) {
        warn(`  Still conflicted: ${remaining.join(', ')}`);
        continue;
      }
      runSafe('git add -A');
      const cont = runSafe('git cherry-pick --continue --no-edit');
      if (cont.code === 0) {
        ok('  Manually resolved. Cherry-pick complete.');
        return 'applied';
      }
      err('  Continue failed: ' + cont.errText);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Prereqs
  try { run('gh --version'); } catch { err('gh CLI not found (https://cli.github.com)'); process.exit(1); }

  const repoRoot = run('git rev-parse --show-toplevel');
  process.chdir(repoRoot);

  const branchCheck = runSafe(
    `git show-ref --verify "refs/heads/${RELEASE_BRANCH}" || ` +
    `git show-ref --verify "refs/remotes/origin/${RELEASE_BRANCH}"`
  );
  if (branchCheck.code !== 0) {
    err(`Release branch "${RELEASE_BRANCH}" not found locally or on origin.`);
    process.exit(1);
  }

  log(`\nFetching from origin...`);
  run('git fetch origin');

  log(`\nLooking for PRs labeled "${LABEL}" merged into "${SOURCE_BRANCH}"...`);
  const prs = getPatchPRs();

  if (prs.length === 0) {
    log(`No merged PRs with label "${LABEL}" on ${SOURCE_BRANCH}.`);
    return;
  }

  log(`\nFound ${prs.length} PR(s):\n`);
  for (const pr of prs) {
    log(`  #${pr.number.toString().padEnd(5)} ${pr.mergeCommit.oid.slice(0, 8)}  ${pr.title}`);
  }

  if (DRY_RUN) {
    log('\n[dry-run mode — no changes will be made]\n');
  } else {
    const confirm = await prompt(`\nApply ${prs.length} PR(s) onto ${RELEASE_BRANCH}? [Y/n]: `);
    if (confirm.toLowerCase() === 'n') { log('Aborted.'); return; }
  }

  const originalBranch = run('git branch --show-current');

  log(`\nChecking out ${RELEASE_BRANCH}...`);
  if (!DRY_RUN) run(`git checkout "${RELEASE_BRANCH}"`);

  const results = { applied: [], 'already-present': [], skipped: [] };

  for (const pr of prs) {
    log(`\n${'─'.repeat(60)}`);
    log(`PR #${pr.number}: ${pr.title}`);
    const outcome = await cherryPickPR(pr);
    (results[outcome] = results[outcome] ?? []).push(pr);
  }

  // Summary
  log(`\n${'═'.repeat(60)}`);
  log(`${C.bold}Summary${C.reset}`);
  if (results.applied?.length)          ok(`  Applied:         ${results.applied.map((p) => '#' + p.number).join(', ')}`);
  if (results['already-present']?.length) log(`  Already present: ${results['already-present'].map((p) => '#' + p.number).join(', ')}`);
  if (results.skipped?.length)          warn(`  Skipped:         ${results.skipped.map((p) => '#' + p.number).join(', ')}`);

  if (!DRY_RUN && results.applied?.length) {
    log(`\nReady to push: git push origin ${RELEASE_BRANCH}`);
  }

  if (!DRY_RUN && originalBranch && originalBranch !== RELEASE_BRANCH) {
    const back = await prompt(`\nReturn to "${originalBranch}"? [Y/n]: `);
    if (back.toLowerCase() !== 'n') run(`git checkout "${originalBranch}"`);
  }
}

main().catch((e) => { err('Fatal: ' + e.message); process.exit(1); });
