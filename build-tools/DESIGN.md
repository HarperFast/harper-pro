# build-tools/ — Design notes

Packaging and the published artifacts (npm tarball, Docker images).

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## The release tarball bundles the locked JavaScript tree, never a host binary (`build-pro.sh`)

`build-pro.sh` packages through core's `core/build-tools/bundleDependencies.ts` (`prepare`, then `check` on the extracted archive), so the mechanism, its native guards and its archive checks are core's — see `core/build-tools/DESIGN.md`. harper-pro adds no policy of its own: core's unbundled list carries pro's two native production roots, `re2` and `@datadog/pprof`. pprof is caught only by the file scan, since it ships `.node` prebuilds without native metadata. A new native production dependency fails packaging with `Cannot bundle native or platform dependency` until its root joins that list in core. No shrinkwrap is published.

`npm ci` keeps lifecycle scripts, unlike core's build. `re2` gets `build/Release/re2.node` only from its install script, and the checkout's WAF and unit tests need it after packaging. Scripts cannot change the bundle undetected: a bundled package may not declare install hooks, and the archive scan rejects native files.

A package harper-pro ships must not also be a devDependency. npm resolves the root's dev edge, so the lock (and the bundle copied from it) can hold a version the published declaration rejects; consumers then see `npm ls` fail with `ELSPROBLEMS invalid`. `sync-core.sh` folds core's development spec into the production entry, and `unitTests/build-tools/bundleDependencies.test.mjs` checks the manifest and lock.

**Reproducibility boundary.** Bundled JavaScript installs byte-identically on npm 10, 11 and 12 for dependency, tarball and global installs. These still float:

- the ranged transitives of unbundled native roots (`re2`: `node-gyp`, `nan`, `install-artifact-from-github`; `@datadog/pprof`: `node-gyp-build`, `p-limit`, `pprof-format`, `source-map`, `delay`);
- the binary `re2` downloads at install;
- optional peers, including `uWebSockets.js`, which the images copy from the build stage;
- Studio, built from HarperFast/studio's `prod` branch at package time.

npm 12 skips dependency install scripts unless allowed. Without `--allow-scripts=re2` (global) or `allowScripts: { "re2": true }` (project), Harper Pro boots with the `waf` component failing to load. The Dockerfiles pass the flag, and npm 10/11 accept it with a warning.

`.github/workflows/npm-package.yaml` installs the Linux-built tarball on Linux (npm 10/11/12, x64 and arm64), macOS and Windows. Each leg runs `npm ci`, `installed` checks, `npm ls --all`, a byte comparison with the archive, native loads (both engines, `argon2`, `re2`, `@datadog/pprof`) and a booted global install. On npm 12 it also asserts the default policy still leaves `re2` unbuilt. Every image build runs the `installed` check against the checkout lock.
