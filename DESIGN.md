# Design notes

- [Replication base-copy compatibility](replication/DESIGN.md#base-copy-peer-safety): reported 5.x peers receive historical copies; v4 and unidentified peers retain baseline verification.
- [A release cherry-pick skips a change its branch already has (`workflows/cherry-pick-patch.yml`, `.github/scripts/change-landed.sh`)](.github/DESIGN.md#a-release-cherry-pick-skips-a-change-its-branch-already-has-workflowscherry-pick-patchyml-scriptschange-landedsh) — skip only when one pick of the PR's whole net change would be empty; replaying a landed PR commit by commit conflicts instead.
- [Release backport verification](scripts/DESIGN.md#release-backport-verification): milestone targeting and the publication gate.
- [The release tarball bundles the locked JavaScript tree, never a host binary](build-tools/DESIGN.md#the-release-tarball-bundles-the-locked-javascript-tree-never-a-host-binary-build-prosh): core's bundler with pro's native roots unbundled, the dev/prod declaration rule, and what still floats.
- [A core sync warns when it drops content the committed pointer has](build-tools/DESIGN.md#a-core-sync-warns-when-it-drops-content-the-committed-pointer-has-sync-coresh-core-sync-guardsh): the sync always proceeds; `core-sync-guard.sh`'s warning (dropped commits and diffstat) leads the Sync Core PR body; detection is the seam test and the cluster shards, prevention is at the merge step.
- [Startup dependencies](#startup-dependencies): packages the built-in components load only on first use.

## Startup dependencies

Every thread loads the built-in components (`HARPER_BUILTIN_COMPONENTS` in `bin/harper.js`), so a package they import at the top level costs each thread heap even when the feature that needs it never runs. lmdb also allocates a 16 MB native buffer per thread on load. As in core (see the lazy-loading paragraph of [core/AGENTS.md](core/AGENTS.md)), lmdb loads on first use at the LMDB-only call site, node-forge through `loadForge()` in `security/certificate.ts`, and lodash is imported per method (`lodash/cloneDeep.js`) rather than as the full build. Type-only imports must be `import type`, because type stripping keeps `import { type X }` as a runtime load.

`unitTests/startupDependencies.test.mjs` loads the built-in component entry points listed in `bin/harper.js` in a fresh process and fails if any of these packages lands in the require cache. It requires Pro's own entry modules (replication, license, analytics, secretCustody, waf) and what they transitively import, so it passes only when those modules' core imports defer them as well; core's own built-in components are covered by a separate core test.
