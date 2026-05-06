# AGENTS.md

This file provides guidance when working with code in this repository.

---

## What This Is

`harper-pro` is the proprietary commercial layer on top of [Harper core](https://github.com/HarperFast/harper) (Apache-2.0). Most engineering conventions, build mechanics, and runtime behaviors are inherited from core — see Harper core's [AGENTS.md](https://github.com/HarperFast/harper/blob/main/AGENTS.md) for the full picture.

---

## Pro-specific notes

- **Linter**: oxlint with `--deny-warnings` (`npm run lint`), same as core.
- **Tests**: only `npm run test:integration` exists here. There is no `test:unit` split — Pro relies on core for unit-test coverage of the substrate it inherits. `test:integration` is slow; run only when the change plausibly affects integration behavior.
- **Storage substrate**: same as core — RocksDB primary, LMDB available via `HARPER_STORAGE_ENGINE=lmdb`.
- **Documentation scope**: https://docs.harperdb.io is authoritative for Harper mechanics. Pro docs describe Pro-only surface, not core behavior.
