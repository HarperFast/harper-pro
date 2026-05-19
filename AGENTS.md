# AGENTS.md

This file provides guidance when working with code in this repository.

---

## What This Is

`harper-pro` is the proprietary commercial layer on top of [Harper core](https://github.com/HarperFast/harper) (Apache-2.0). Most engineering conventions, build mechanics, and runtime behaviors are inherited from core — see Harper core's [AGENTS.md](https://github.com/HarperFast/harper/blob/main/AGENTS.md) for the full picture.

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

## Pro-specific notes

- **Linter**: oxlint with `--deny-warnings` (`npm run lint`), same as core.
- **Tests**: only `npm run test:integration` exists here. There is no `test:unit` split — Pro relies on core for unit-test coverage of the substrate it inherits. `test:integration` is slow; run only when the change plausibly affects integration behavior.
- **Storage substrate**: same as core — RocksDB primary, LMDB available via `HARPER_STORAGE_ENGINE=lmdb`.
- **Documentation scope**: https://docs.harperdb.io is authoritative for Harper mechanics. Pro docs describe Pro-only surface, not core behavior.
