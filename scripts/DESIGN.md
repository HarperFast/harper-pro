# Release backport verification

`patch-release.js` verifies milestone-targeted merged PRs with `isPRPresent` before `--yes` can publish; `unitTests/scripts/patchReleasePresence.test.mjs` enforces ancestry, trailer and patch-ID evidence, complete original-commit coverage, and missing-backport aborts in both repositories. Historical picks without matching evidence require interactive verification, as documented in `CONTRIBUTING.md`.
