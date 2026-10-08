# Design notes

- [A release cherry-pick skips a change its branch already has (`workflows/cherry-pick-patch.yml`, `.github/scripts/change-landed.sh`)](.github/DESIGN.md#a-release-cherry-pick-skips-a-change-its-branch-already-has-workflowscherry-pick-patchyml-scriptschange-landedsh) — skip only when one pick of the PR's whole net change would be empty; replaying a landed PR commit by commit conflicts instead.
- [Release backport verification](scripts/DESIGN.md#release-backport-verification): milestone targeting and the publication gate.
- [The release tarball bundles the locked JavaScript tree, never a host binary](build-tools/DESIGN.md#the-release-tarball-bundles-the-locked-javascript-tree-never-a-host-binary-build-prosh): core's bundler with pro's native roots unbundled, the dev/prod declaration rule, and what still floats.
