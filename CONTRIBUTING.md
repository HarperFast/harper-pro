# Contributing to Harper Pro

Harper Pro is a source-available project licensed under [the Elastic License 2.0](https://www.elastic.co/licensing/elastic-license).
Currently we do not accept contributions to Harper Pro, but [Harper](https://github.com/HarperFast/harper)
(which Harper Pro builds upon) is open source and does accept contributions.

## Local Git Setup

### Reducing package-lock.json merge conflicts

The repository includes a `.gitattributes` entry that registers `npm-merge-driver` as the merge strategy for `package-lock.json`. To enable automatic conflict resolution when merging or rebasing locally, install it once:

```bash
npx npm-merge-driver install --global
```

This is optional — without it you'll see standard merge conflict behavior. The driver is not used for server-side PR merges on GitHub.

## Patch Release Procedure

> This section is for maintainers creating patch releases against a stable release branch (e.g. `v5.0`).

The `scripts/patch-release.js` script automates the full patch release workflow:

1. Fetches both repositories, pins each release candidate (the fetched `origin/<branch>` commit), and checks that merged PRs whose milestones target the release line are present on it in both `core` ([HarperFast/harper](https://github.com/HarperFast/harper)) and `harper-pro`. When the release branch is the source branch (a main-line release cut from `main`), there is nothing to backport and the script says `Backport verification not applicable` instead of reporting a pass.
2. Checks that the required CI workflows passed on both candidates: `unit-test.yml` and `integration-tests.yml` in core, `unit-tests.yaml` and `integration-tests.yaml` in harper-pro.
3. Bumps core's version and tags it if core has new commits, then runs `build-tools/sync-core.sh` to update the core submodule pointer and sync its dependencies into harper-pro.
4. Bumps harper-pro's version, commits and tags it, then pushes the release branches and new tags automatically.
5. Offers to trigger Central Manager's release-to-environments workflow. In `--yes` mode this step requires `--cm-trigger`.

### Marking a PR for patching

Set the PR's milestone to the earliest release line that should receive it (e.g. `v5.1`). The cherry-pick workflow targets that line and every newer minor line of the same major; a patch milestone such as `v5.1.4` targets the `v5.1` line. The `patch` label does not select backports, and the release script rejects the obsolete `--label` flag.

The workflow applies backports separately from the release script. Resolve and land any conflicted or held backports before releasing.

The script verifies all merged PRs targeting the line, including PRs merged before the last release or milestoned later. It accepts a reachable merge commit, an exact `git cherry-pick -x` trailer, or a matching stable patch ID. For squash/rebase cherry-picks, a single merge SHA or its trailer also needs proof that it represents the whole PR. For multi-commit PRs, it also checks that every original non-merge commit landed. Merge commits that differ from Git's automatic merge require their own provenance or proof of the whole PR; ordinary picks alone cannot cover their resolution edits. It checks the whole release history, so backports in earlier releases remain covered.

Missing backports are listed before interactive confirmation. With `--yes`, any missing backport aborts before versioning, tagging or pushing, including in `--dry-run`; it exits nonzero and emits a `RESULT: {...}` line even without `--json`, with `ok: false`, `missingPRs`, `pushed: false` and `cmTriggered: false`. There is no non-interactive waiver. If a manually resolved or contextual backport lacks matching provenance or patch IDs, verify it manually and run interactively. The same applies when GitHub's original-commit list reaches its 250-commit limit and cannot prove coverage. Custom release branches (including `--core-branch` RC branches) use their package version's major/minor to select milestones; the workflow only targets `vX.Y` branches automatically.

### Release-candidate CI

The release commit is created locally, so CI cannot run on it before it is tagged. The script instead requires that the commit it builds on is green in each repository. For each required workflow it reads the runs on that exact commit (`pull_request` runs are ignored because they test a merge ref) and takes each job's result from the latest run that contains the job. A later single-Node dispatch therefore cannot hide a job that failed in an earlier full-matrix run. Missing runs, runs still in progress, failed or cancelled jobs, and API errors all block.

Release branches advanced by the cherry-pick workflow usually have no runs on their head: its pushes use `GITHUB_TOKEN`, which does not trigger push workflows. The script prints the command to start a run, e.g. `gh workflow run integration-tests.yml --repo HarperFast/harper --ref v5.3`. Wait for it to finish, then re-run the release. The `gh` token needs Actions read access to both repositories.

With `--yes`, non-green CI aborts before versioning, tagging or pushing (including `--dry-run`): nonzero exit and a `RESULT` line even without `--json`, with `ciFailures` (repo, branch, sha, workflow, job, state, url or error). Interactively, the failing checks are printed and the proceed prompt asks you to confirm overriding the gate. For an emergency release, `--ci-override "<reason>"` proceeds in either mode; the reason is printed and recorded as `ciOverride` in `RESULT`. It does not waive missing backports.

The gate checks each repository's own commit. Harper-pro's CI ran against harper-pro's own `core` pointer, while the release re-pins core to the core candidate. When those differ, the script warns, and `RESULT.candidates.proCoreGitlink` differs from `candidates.core`: that pairing is untested until the release commit's own CI runs.

### Running the script

```bash
node scripts/patch-release.js
```

**Options:**

| Flag                      | Default             | Description                                                                                                           |
| ------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--branch <name>`         | `v5.0`              | Release branch to package                                                                                             |
| `--core-branch <name>`    | Same as `--branch`  | Core release branch when its name differs                                                                             |
| `--source <name>`         | `main`              | Source branch whose merged PRs are checked                                                                            |
| `--bump <type>`           | `patch`             | npm version bump type: `patch`, `minor`, `major`, or `prerelease`                                                     |
| `--set-version <version>` | —                   | Explicit target version, e.g. `5.2.0-beta.1`                                                                          |
| `--version-name <slot>`   | Derived from target | CM slot: `stable` for GA, `next` for prereleases; explicit value overrides                                            |
| `--dry-run`               | —                   | Preview all actions without making changes                                                                            |
| `--yes`                   | —                   | Non-interactive: auto-confirm all prompts. CM deploy defaults to skipped in this mode — pass `--cm-trigger` to opt in |
| `--cm-trigger`            | —                   | Request CM release-to-environments. With `--yes`, auto-confirms; without it, still prompts interactively              |
| `--ci-override <reason>`  | —                   | Emergency release past non-green required CI; the reason is printed and recorded in `RESULT`                          |
| `--json`                  | —                   | Print a final `RESULT: {...}` JSON line on stdout for machine parsing (success, abort, or fatal error)                |

A successful `RESULT` also carries `backportVerification` (`passed`, `missing` or `not-applicable` per repository), `candidates` (`core`, `pro`, `proCoreGitlink` SHAs), `ciFailures`, and `ciOverride` (`null` or `{ "reason": ... }`). Closed stdin answers the proceed and CM deploy prompts "no"; the branch-restore prompts keep their default and restore. A declined or closed proceed prompt emits the aborted `RESULT` with the same gate fields.

**Example — preview what would be applied:**

```bash
node scripts/patch-release.js --dry-run
```

The script pushes the release branches and their new tags in Step 5. No separate manual push is needed. `--dry-run` previews the release without bumping versions, tagging or pushing.

---

## Repository Sync Procedure

> This section is only relevant to repository maintainers responsible for the
> temporary synchronization of the old, internal repository and this one.

> This procedure assume the old HarperDB repo is set as the `old` git remote
>
> ```
> git remote add old git@github.com:HarperFast/harperdb.git
>
> # Only fetch `main` branch
> git config remote.old.fetch '+refs/heads/main:refs/remotes/old/main'
> ```

1. Make sure local `main` branch is checked out and clean `git checkout main && git status`.
2. Copy the [latest previously-synced commit hash from this file](#last-synchronized-commit).
3. Run the sync-commits helper script: `dev/sync-commits.js <previously-synced-commit-hash>`
4. For each commit the script lists, run the `git cherry-pick ...` command it suggests.
   - NB: Some of these may have `-m 1` params to handle merge commits correctly.
5. If either cherry-pick command results in a non-zero exit code that means there is a merge conflict.
   1. If the conflict is a content, resolve it manually and `git add` the file
      - Example: `CONFLICT (content): Merge conflict in package.json`
   2. Else if the conflict is a modify/delete then likely `git rm` the file
      - Example: `CONFLICT (modify/delete): unitTests/bin/copyDB-test.js deleted in HEAD and modified in f75d9170b`
   3. Then check `git status`, if there is nothing you can `git cherry-pick --skip`
      - Note: in this circumstance, running `git cherry-pick --continue` results in a non-zero exit code with the message `The previous cherry-pick is now empty, possibly due to conflict resolution.` Maybe we use this to then run `--skip`? Or maybe there is a way to parse the output of previous `git status` step?
6. After all commits have been picked, manually check that everything brought over was supposed to be. Look out for any source code we do not want open-sourced or things like unit tests which we are actively migrating separately (and will eventually include as part of the synchronization process)
   - The GitHub PR UI is useful for this step; but make sure to leave the PR as a draft until all synchronization steps are complete
7. Once everything looks good, run `npm run format:write` to ensure formatting is correct
8. Commit the formatting changes
9. Add the formatting changes commit from the previous step to the `.git-blame-ignore-revs` file under the `# Formatting Changes` section
10. Record the last commit that was cherry-picked from `old/main` and record it below in order to make the next synchronization easier. **Make sure to record the commit hash from `old/main` and not the new hash**
11. Commit the changes to this file to mark the synchronization complete
12. Push all changes and open the PR for review
13. Merge using a Merge Commit so that all relative history is retained and things like the formatting change hash stays the same as recorded.

### Last Synchronized Commit

`cd20460b4110812e2751fd2e24e17b0e3a2c83d1`
