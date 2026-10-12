# .github/ — Design notes

CI workflows.

**Read this when:** changing what the release cherry-pick decides to pick, or what `companion-check` lets merge.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## A release cherry-pick skips a change its branch already has (`workflows/cherry-pick-patch.yml`, `scripts/change-landed.sh`)

It needs Git 2.40 or newer (`merge-tree --merge-base`); older Git exits 2, which picks. Before picking, the cherry-pick job asks `scripts/change-landed.sh` whether one pick of the PR's whole net change onto the release branch would come out empty: `git merge-tree` of that change, with its own base as the merge base, is clean and leaves the release tree unchanged. Only that answer skips the PR, with no branch and no PR. A change whose file content is partly present, reverted, or conflicting picks as before, and so does a check that cannot run. "Empty" is decided by Git's merge rules, the same rules the picks themselves run under: a gitlink the release already moved past, or a configured merge driver that keeps the release's side, counts as present for both. This is the empty-pick test `scripts/apply-picks.sh` already applies to each commit, lifted to the net change. Replaying a landed PR one commit at a time re-applies each intermediate commit against its own final content, which conflicts instead of coming out empty. harper#3067 was the second run of a `demilestoned`/`milestoned` pair re-picking harper#3038 onto the v5.3 the first run had just landed it on.

The net change is `MERGE_BASE..HEAD_SHA` when the job replays the PR's commits, which includes any merge-commit resolutions; a contained change therefore also clears that hold. It is `MERGE_SHA^1..MERGE_SHA` for a PR merged with a merge commit. The fallback that builds from a lone merge commit is not provably the whole change, so it is never checked and keeps its hold. The check runs after the release branch is checked out, so it reads the same `.gitattributes` as the picks. A landing that moves the release tip between the pick and the push is the same change, so each retry rebuild checks the new tip before it replays anything. `unitTests/github/cherryPickPatch.test.mjs` runs the shipped job's steps against a fixture origin.

## A marker-free PR is green only if every submodule pointer it moves is settled (`workflows/companion-check.yaml`)

The `companion-check` status is the one gate every PR passes on every push and body edit, so the declaration rule lives there and not only in Dispatch's pre-PR CLI (`dispatch/lib/companion.mjs`, whose settle-branch rule this ports; keep the two in step). Without a `Depends-on:` marker, each gitlink the PR adds or moves must name a commit that `compare <settle>...<sha>` reports `behind` or `identical`. The settle branch is the submodule repo's branch named like the PR's base, else its default branch, never `.gitmodules` `branch =`, which says `main` on every release line. Unsettled is `failure`, since only a body edit or a re-point fixes it; anything the check could not read is `pending`. A PR with a marker is judged on its companions alone.

Gitlinks come from `pulls.listFiles`: an entry is one when its patch adds `Subproject commit <sha>` and its `sha` is that commit. GitHub drops the patch, and zeroes the line counts, for binary and empty files and for every entry past a page's diff budget (microsoft/TypeScript#28572 at `per_page=100`: entries from about 86 on), so a patchless entry is decided by the head commit's recursive tree (mode `160000`), never by its counts. The listing stops at 3000 files, so a listing that long certifies nothing. The submodule repo comes from the contents API at the PR head, never the parent repo's own remote, and these lookups use only `GITHUB_TOKEN` because the URL is PR-controlled. Commit statuses are per SHA, so two PRs sharing a head on different bases share one verdict. `build-tools/companion-check.test.mjs` runs the embedded script against fakes shaped like the live API.
