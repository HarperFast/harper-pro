# Design notes

- [Replication base-copy compatibility](replication/DESIGN.md#base-copy-peer-safety): reported 5.x peers receive historical copies; v4 and unidentified peers retain baseline verification.
- [Release backport verification](scripts/DESIGN.md#release-backport-verification): milestone targeting and the publication gate.
- [The release tarball bundles the locked JavaScript tree, never a host binary](build-tools/DESIGN.md#the-release-tarball-bundles-the-locked-javascript-tree-never-a-host-binary-build-prosh): core's bundler with pro's native roots unbundled, the dev/prod declaration rule, and what still floats.
