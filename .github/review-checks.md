---
layers: universal, harper/common, harper/v5
---

## Repo-specific checks (Harper Pro)

Harper Pro is the proprietary layer on top of Harper core
(HarperFast/harper). Code here may add or modify Pro-only
resources/APIs and pull from Harper core internals.

- **Linter is oxlint, not eslint.** `npm run lint` runs
  oxlint with `--deny-warnings`. Advice in layers that
  references ESLint doesn't apply.
- **Documentation scope.** Harper docs at
  https://docs.harperdb.io are authoritative for Harper
  mechanics. Pro-side docs should describe Pro-only
  surface, not re-explain core behavior.
- **Storage.** Same substrate as Harper core — RocksDB
  primary, LMDB available via `HARPER_STORAGE_ENGINE=lmdb`.
- **Tests.** `npm run test:unit` (mocha over `unitTests/`;
  needs a built `dist/` — run `npm run build` first) for fast
  unit coverage; `npm run test:integration` for the
  integration surface. The integration suite is slow — use
  it judiciously.
