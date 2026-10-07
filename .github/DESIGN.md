# .github/ — Design notes

CI workflows.

**Read this when:** changing what the release cherry-pick decides to pick.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## A release cherry-pick skips a change its branch already has (`workflows/cherry-pick-patch.yml`, `scripts/change-landed.sh`)

Before picking, the cherry-pick job asks `scripts/change-landed.sh` whether one pick of the PR's whole net change onto the release branch would come out empty: `git merge-tree` of that change, with its own base as the merge base, is clean and leaves the release tree unchanged. Only that answer skips the PR, with no branch and no PR. A change whose file content is partly present, reverted, or conflicting picks as before, and so does a check that cannot run. "Empty" is decided by Git's merge rules, the same rules the picks themselves run under: a gitlink the release already moved past, or a configured merge driver that keeps the release's side, counts as present for both. This is the empty-pick test `scripts/apply-picks.sh` already applies to each commit, lifted to the net change. Replaying a landed PR one commit at a time re-applies each intermediate commit against its own final content, which conflicts instead of coming out empty. harper#3067 was the second run of a `demilestoned`/`milestoned` pair re-picking harper#3038 onto the v5.3 the first run had just landed it on.

The net change is `MERGE_BASE..HEAD_SHA` when the job replays the PR's commits, which includes any merge-commit resolutions; a contained change therefore also clears that hold. It is `MERGE_SHA^1..MERGE_SHA` for a PR merged with a merge commit. The fallback that builds from a lone merge commit is not provably the whole change, so it is never checked and keeps its hold. The check runs after the release branch is checked out, so it reads the same `.gitattributes` as the picks. A landing that moves the release tip between the pick and the push is the same change, so each retry rebuild checks the new tip before it replays anything. `unitTests/github/cherryPickPatch.test.mjs` runs the shipped job's steps against a fixture origin.
