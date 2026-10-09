# build-tools/ — Design notes

Packaging and the published artifacts (npm tarball, Docker images).

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## The release tarball bundles the locked JavaScript tree, never a host binary (`build-pro.sh`)

`build-pro.sh` packages through core's `core/build-tools/bundleDependencies.ts` (`prepare`, then `check` on the extracted archive), so the mechanism, its native guards and its archive checks are core's — see `core/build-tools/DESIGN.md`. harper-pro adds no policy of its own: core's unbundled list carries pro's two native production roots, `re2` and `@datadog/pprof`. pprof is caught only by the file scan, since it ships `.node` prebuilds without native metadata. A new native production dependency fails packaging with `Cannot bundle native or platform dependency` until its root joins that list in core. No shrinkwrap is published.

Packaging installs with `npm ci --ignore-scripts`, like core. The bundle is copied from `node_modules` and then checked by version, native metadata and native file signatures, not by content. Without the flag, any install script (`esbuild`'s or `re2`'s, for example) could rewrite a bundled package's JavaScript, and that edit would ship to every consumer undetected. The exit trap runs `npm rebuild re2` after the archive is final, or after a failure, because `re2.node` comes only from that script and the checkout's WAF and tests need it. Like core, packaging deletes `dist/` and stops on a compile error rather than shipping whatever `tsc` emitted.

A package harper-pro ships must not also be a devDependency. npm resolves the root's dev edge, so the lock (and the bundle copied from it) can hold a version the published declaration rejects; consumers then see `npm ls` fail with `ELSPROBLEMS invalid`. `sync-core.sh` folds core's development spec into the production entry, and `unitTests/build-tools/bundleDependencies.test.mjs` checks the manifest and lock.

**Reproducibility boundary.** Bundled JavaScript installs byte-identically on npm 10, 11 and 12 for dependency, tarball and global installs. These still float:

- the ranged transitives of every unbundled root: pro's `re2` (`node-gyp`, `nan`, `install-artifact-from-github`) and `@datadog/pprof` (`node-gyp-build`, `p-limit`, `pprof-format`, `source-map`, `delay`), and core's, such as `tar-stream`'s `streamx` and `argon2`'s `@phc/format`;
- the binary `re2` downloads at install;
- optional peers, including `uWebSockets.js`, which the images copy from the build stage;
- Studio, built from HarperFast/studio's `prod` branch at package time.

npm 12 skips dependency install scripts unless allowed. Without `--allow-scripts=re2` (global) or `allowScripts: { "re2": true }` (project), Harper Pro boots with the `waf` component failing to load. The Dockerfiles pass the flag; npm 10 ignores it and npm 11 warns about it.

`.github/workflows/npm-package.yaml` installs the Linux-built tarball on Linux (npm 10/11/12, x64 and arm64), macOS and Windows. Each leg runs `npm ci`, `installed` checks, `npm ls --all`, a byte comparison with the archive, native loads (both engines, `argon2`, `re2`, `@datadog/pprof`) and a booted global install. On npm 12 it also asserts the default policy still leaves `re2` unbuilt. Every image build runs the `installed` check against the checkout lock.

## A core sync never removes content the committed pointer has (`sync-core.sh`, `core-sync-guard.sh`)

`npm run core:sync` re-points `core` at the tip of its tracked branch. A coordinated PR merged ahead of its core companion leaves the pointer on that companion's branch; the tip then lacks changes harper-pro already builds against, and the sync would remove them with nothing failing until an integration test waits on behaviour that is gone (harper-pro#1016 dropped harper#3109's seq-row floor merge under #1011; every Cluster 6/6 leg timed out). `sync-core.sh` therefore fetches the tip, freezes its SHA, and runs `core-sync-guard.sh` before anything moves; only the validated SHA is checked out. The guard passes a pointer that is the tip or an ancestor of it, or whose merge into the tip reproduces the tip's own tree — which admits a companion that was squash- or rebase-merged, whose commits are not ancestors but whose content is present. A conflict or any remaining diff is refused with the diffstat, an unreadable object or failed fetch is undecidable (exit 2), and `CORE_SYNC_DROP_CONTENT=true` (that exact value) is the deliberate override, logged with both SHAs. The guarantee is preservation of the pointer's outstanding changes, not compatibility: a descendant that deliberately reverts a feature passes the ancestor test, so behaviour stays pinned by tests such as `unitTests/replication/originFloorSeqRow.test.mjs`, which fails in seconds against a core that ignores `originFloors`. The ancestor test is the nightly path and costs one `merge-base`; only the fallback unshallows a shallow CI checkout. `unitTests/build-tools/coreSyncGuard.test.mjs` runs both scripts against fixture repositories.
