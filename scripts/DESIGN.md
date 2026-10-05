# Release backport verification

`patch-release.js` verifies milestone-targeted merged PRs with `isPRPresent` before `--yes` can publish; `unitTests/scripts/patchReleasePresence.test.mjs` enforces ancestry, trailer and patch-ID evidence, complete original-commit coverage, and missing-backport aborts in both repositories. Historical picks without matching evidence require interactive verification, as documented in `CONTRIBUTING.md`.

A release branch that is the source branch (a main-line release) contains every PR merged to it, so ancestry there proves nothing: `backportVerificationApplies` makes that case report `not-applicable`, never `passed`.

# Release-candidate CI gate

Each repository's candidate is the `origin/<branch>` commit pinned once after fetch; backport history, version reads, the CI query and the release commit's parent all use that SHA, and `assertReleaseBase` refuses a HEAD or staged change that differs from it in both repositories before either gets a release commit. `evaluateWorkflowRuns` decides green per job (latest run containing the job wins, `pull_request` runs excluded) over `REQUIRED_WORKFLOWS`, so a narrower re-run cannot mask an earlier failure. Missing, unfinished (any run, not just the latest), job-less, failed and unreadable evidence all block; only `--ci-override <reason>` or the interactive proceed confirmation passes them, recorded as `ciOverride`. Pro CI tests pro's own core gitlink, not the core the release re-pins, which `candidates.proCoreGitlink` exposes. Tests: `unitTests/scripts/patchReleasePresence.test.mjs` (`evaluateWorkflowRuns`, `release-candidate CI gate`, `release cut from the source branch`).
