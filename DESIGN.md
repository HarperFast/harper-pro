# Design notes

- [Release backport verification](scripts/DESIGN.md#release-backport-verification): milestone targeting and the publication gate.
- [Startup dependencies](#startup-dependencies): packages the built-in components load only on first use.

## Startup dependencies

Every thread loads the built-in components (`HARPER_BUILTIN_COMPONENTS` in `bin/harper.js`), so a package they import at the top level costs each thread heap even when the feature that needs it never runs. lmdb also allocates a 16 MB native buffer per thread on load. As in core (see the lazy-loading paragraph of [core/AGENTS.md](core/AGENTS.md)), lmdb loads on first use at the LMDB-only call site, node-forge through `loadForge()` in `security/certificate.ts`, and lodash is imported per method (`lodash/cloneDeep.js`) rather than as the full build. Type-only imports must be `import type`, because type stripping keeps `import { type X }` as a runtime load.

`unitTests/startupDependencies.test.mjs` loads the built-in component entry points listed in `bin/harper.js` in a fresh process and fails if any of these packages lands in the require cache. It covers core's startup graph too, so it passes only with a core that defers them as well.
