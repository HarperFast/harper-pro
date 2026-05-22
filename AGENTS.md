# AGENTS.md

This file provides guidance when working with code in this repository.

---

## What This Is

`harper-pro` is the proprietary commercial layer on top of [Harper core](https://github.com/HarperFast/harper) (Apache-2.0). Most engineering conventions, build mechanics, and runtime behaviors are inherited from core — **read [core/AGENTS.md](core/AGENTS.md) for the substrate's full picture**. This document covers only what's different or additive in Pro.

`core/` is a git submodule pointing at `HarperFast/harper`. Pro adds: cluster replication, license enforcement, clone-node bootstrap, CPU profiling, and the docker-compose dev workflow.

---

## Submodule / Git Setup — Read Before Any Git Operation

The `core/` subdirectory is a git submodule. Its git data lives at `.git/modules/core/`.

**Do not run `git submodule deinit core` followed by re-init.** Doing so regenerates
`.git/modules/core/config` without the required `core.worktree = ../../../core` setting.
When that setting is absent, git treats the git data dir as its own work tree; the next
`git checkout` deposits source files (including a `config/` directory) directly into
`.git/modules/core/`, permanently shadowing git's config file and breaking all subsequent
git operations for every agent until manually repaired.

If `.git/modules/core/config` is ever recreated from scratch it **must** contain:
```
[core]
    worktree = ../../../core
```

If you see source-tree directories (e.g. `server/`, `resources/`, `config/`) appearing
inside `.git/modules/core/`, remove them immediately — they are corrupting the git data dir.

---

## Commands

```bash
# Build (Pro-only — core has its own build)
npm run build              # tsc → dist/
npm run build:watch        # incremental

# Lint / Format
npm run lint               # oxlint --deny-warnings
npm run lint:fix
npm run format:write       # prettier
npm run lint:required      # quiet — for CI

# Tests
npm run test:unit                  # mocha unit tests (fast, no server — build first)
npm run test:integration
npm run test:integration:all   # all *.test.ts in integrationTests/

# Submodule
npm run core:sync              # sync core submodule to its pinned commit
npm run core:set-branch        # pin core to a different branch
```

The `cluster:*` scripts in `package.json` reference `utility/dev/docker-compose.*.yml` files that are not present in the repository — they're likely produced by a private dev tooling step. Don't expect them to work out of the box.

`test:unit` runs `unitTests/**/*.test.mjs` via mocha (requires a built `dist/` — run `npm run build` first). `test:integration` is slow — run only when the change plausibly affects integration behavior.

---

## Where should this change go? (Pro vs. core)

If you're not sure which repo to edit, use this rule of thumb:

| Change concerns…                                            | Edit in                                            |
| ----------------------------------------------------------- | -------------------------------------------------- |
| Tables, Resources, transactions, audit, storage format      | `core/`                                            |
| HTTP/WS/MQTT/GraphQL protocol handling, middleware          | `core/`                                            |
| Schema, validation, permissions                             | `core/`                                            |
| Multi-node replication, cluster status, node membership     | `harper-pro/replication/`                          |
| Initial node clone from a leader                            | `harper-pro/cloneNode/`                            |
| License validation/enforcement                              | `harper-pro/licensing/`                            |
| CPU profiling / pprof integration                           | `harper-pro/analytics/`                            |
| TLS cert signing for cluster auth                           | `harper-pro/security/`                             |
| `bin/harper.js` CLI behavior (component registration order) | `harper-pro/bin/`                                  |
| Build / packaging / release scripts                         | `harper-pro/build-tools/` or `harper-pro/scripts/` |

When a feature spans both, prefer landing as much as possible in `core/` and gluing it together via a Pro-registered component.

---

## Repository map

### Pro source folders

- **`bin/`** — CLI entry points. `harper.js` is the main executable; loads `cloneNode` if `HDB_LEADER_URL` is set; registers `analytics`, `licensing`, `replication` components.
- **`replication/`** — multi-node replication subsystem. **See [replication/DESIGN.md](replication/DESIGN.md)** for the section index. The big file is `replication/replicationConnection.ts` (2288 lines).
- **`cloneNode/`** — `cloneNode.ts` (~30KB). One-shot replication from a leader during init when `HDB_LEADER_URL` is set. Auth via cert or credentials. Tests: `integrationTests/cloneNode/`.
- **`licensing/`** — usage license validation and enforcement. `usageLicensing.ts` (lifecycle, usage aggregation) and `validation.ts` (EdDSA signature verification).
- **`analytics/`** — CPU profiling via Datadog pprof. `profile.ts` is the entry. **Not the same as core's `resources/analytics/`** (which records request-level telemetry).
- **`security/`** — Pro-specific cryptography: `certificate.ts` (TLS signing/validation), `sshKeyOperations.ts`, `keyService.ts` (JWT + private-key resolution). **Core PKI lives in `core/security/`** — don't confuse them.

### Pro tests

- **`integrationTests/`** — end-to-end, runs full Harper instances. `run.mjs` is the custom test harness with shard support. Subdirs mirror source (`analytics/`, `cloneNode/`, `cluster/`, `licensing/`, `security/`).
- **`unitTests/`** — mocha unit tests (`npm run test:unit`). `testUtils.js` (mock helpers, db reset), `setupTestApp.mjs` (in-memory app scaffold), `unitTestSetup.cjs` (env bootstrap required before ESM module load).

### Pro non-source

- **`build-tools/`** — `build-pro.sh` orchestrates the build; `sync-core.sh` syncs the core submodule; `download-prebuilds.js` fetches native prebuilds; `set-core-branch.sh` pins core's branch.
- **`scripts/`** — `patch-release.js` (~12KB). Cherry-picks PRs labeled `patch` from `main` onto a release branch in both core and Pro, bumps the version, syncs the submodule. See `CONTRIBUTING.md` for usage.
- **`dev/`** — `sync-commits.js`. One-time repo-migration utility, not part of normal runtime.
- **`static/`** — `defaultConfig.yaml` template, `ascii_logo.txt`.

### Submodule

- **`core/`** — the Harper OSS core (`HarperFast/harper`). Has its own AGENTS.md, DESIGN.md, and now per-folder DESIGN.md docs. **When touching substrate behavior, edit there, not here.**

---

## Pro-specific conventions

- **Linter**: `oxlint --deny-warnings`, same as core.
- **Storage substrate**: same as core — RocksDB primary, LMDB available via `HARPER_STORAGE_ENGINE=lmdb`.
- **Documentation scope**: https://docs.harperdb.io is authoritative for Harper mechanics. Pro docs describe Pro-only surface, not core behavior.
- **Submodule pointer**: when changing core, commit there first, then bump the submodule pointer in Pro in a separate commit. Don't combine core changes with submodule bumps — they need to be reviewable separately.
- **Patch releases**: PRs that should land in a stable release branch must carry the **`patch`** label. See `CONTRIBUTING.md` for the patch-release workflow.

---

## Cross-references

- **[core/AGENTS.md](core/AGENTS.md)** — substrate architecture (Resources, Server, Components, Data Layer). Read first for substrate questions.
- **[core/DESIGN.md](core/DESIGN.md)** — non-obvious internals (RecordObject prototype, getFromSource timing, blob orphan cleanup).
- **[core/resources/DESIGN.md](core/resources/DESIGN.md)** — `Table.ts` and `Resource.ts` section indexes.
- **[core/server/DESIGN.md](core/server/DESIGN.md)** — HTTP/WS/MQTT layer + middleware ordering.
- **[replication/DESIGN.md](replication/DESIGN.md)** — Pro replication subsystem.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — patch release procedure; package-lock merge driver setup.
