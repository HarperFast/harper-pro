# Contributing to Harper Pro

Harper Pro is a source-available project licensed under [the Elastic License 2.0](https://www.elastic.co/licensing/elastic-license).
Currently we do not accept contributions to Harper Pro, but [Harper](https://github.com/HarperFast/harper)
(which Harper Pro builds upon) is open source and does accept contributions.

<<<<<<< HEAD
=======
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

1. Cherry-picks PRs labeled **`patch`** from `main` onto the release branch in both `core` ([HarperFast/harper](https://github.com/HarperFast/harper)) and `harper-pro`.
2. Bumps the patch version in `package.json`, commits it, and creates a git tag in each repo.
3. Runs `build-tools/sync-core.sh` to update the core submodule pointer and sync core's dependencies into harper-pro.

### Marking a PR for patching

Add the **`patch`** label to any merged PR on `main` that should be included in the next patch release. Squash-merging is strongly recommended so there is exactly one commit SHA to cherry-pick.

### Running the script

```bash
node scripts/patch-release.js
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--branch <name>` | `v5.0` | Release branch to apply patches to |
| `--source <name>` | `main` | Source branch to pull patches from |
| `--label <name>` | `patch` | PR label to filter on |
| `--bump <type>` | `patch` | npm version bump type: `patch`, `minor`, or `major` |
| `--dry-run` | — | Preview all actions without making changes |

**Example — preview what would be applied:**
```bash
node scripts/patch-release.js --dry-run
```

**After the script completes**, push both repos and their new tags:
```bash
git -C core push origin v5.0 --follow-tags
git push origin v5.0 --follow-tags
```

### AI-assisted conflict resolution (optional)

If a cherry-pick produces conflicts, the script can ask Claude to resolve them automatically. To enable:

```bash
npm install -g @anthropic-ai/sdk
export ANTHROPIC_API_KEY=sk-ant-...
```

When AI resolution is not available or leaves unresolvable files, the script pauses and prompts for manual resolution before continuing.

---

>>>>>>> cb27303 (document npm-merge-driver setup in CONTRIBUTING.md)
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
