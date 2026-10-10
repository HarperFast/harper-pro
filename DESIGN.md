# Design notes

<<<<<<< HEAD
=======
- [Replication base-copy compatibility](replication/DESIGN.md#non-obvious-behaviors): reported 5.x peers receive historical copies; v4 and unidentified peers retain baseline verification.
- [A release cherry-pick skips a change its branch already has (`workflows/cherry-pick-patch.yml`, `.github/scripts/change-landed.sh`)](.github/DESIGN.md#a-release-cherry-pick-skips-a-change-its-branch-already-has-workflowscherry-pick-patchyml-scriptschange-landedsh) — skip only when one pick of the PR's whole net change would be empty; replaying a landed PR commit by commit conflicts instead.
>>>>>>> 0cfe8a4 (Allow base copies to published 5.x peers during rolling upgrades)
- [Release backport verification](scripts/DESIGN.md#release-backport-verification): milestone targeting and the publication gate.
- [The release tarball bundles the locked JavaScript tree, never a host binary](build-tools/DESIGN.md#the-release-tarball-bundles-the-locked-javascript-tree-never-a-host-binary-build-prosh): core's bundler with pro's native roots unbundled, the dev/prod declaration rule, and what still floats.
