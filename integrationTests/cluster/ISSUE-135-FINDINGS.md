# Issue #135 — Integration Test Findings

## What we know

The bug (Resource SDK `tables.X.search` returns subset after Harper restart, ops API returns full set) does NOT reproduce in any of the following single-process or single-node scenarios:

**Unit test layer (`core/unitTests/resources/indexSearchAfterRestart.test.js`):**

- In-process `resetDatabases()` + search by indexed attribute. **Passes.**
- Real subprocess boundary (writer forks, exits, reader opens same DB). **Passes.**
- Adding `@indexed` to an existing attribute (schema migration), with and without awaiting `indexingOperation`. **Passes.**
- Mid-flight `resetDatabases()` interrupting a schema reindex. **Passes.**

**Integration test layer (`issue135-resource-search-after-restart.test.mjs`):**

- Scenario A: deploy fixture component → insert 100 rows → graceful `{operation:'restart'}` → `search_by_value` (ops API) vs `/SearchCount?snapshotId=…` (Resource SDK via `tables.ScoreEvidence.search`). **Both return 100. Passes.**

## Multi-node scenarios: blocked

Scenarios B/C/D (write on node A → replicate to node B → restart node B → search on node B) require cluster setup via `create_authentication_tokens` + `add_node`. This fails in the current integration test environment:

```
AssertionError: {"error":"unable to generate JWT as there are no encryption keys."}
```

This same failure blocks `replicationLoad.test.mjs` and `fullyConnectedReplication.test.mjs`.

## Most likely root cause

Based on the single-node results all passing, the bug is almost certainly replication-specific:

- Rows written locally survive restart fine (Scenario A).
- Rows received **via replication replay** on a secondary node may not have their secondary index entries (in `RocksIndexStore`) correctly restored on restart.
- The ops API (`search_by_value`) scans the primary store and filters — it sees everything.
- `tables.X.search` walks the secondary index — it misses the replicated rows whose index entries weren't rebuilt.

Supporting evidence: the user observed the bug on BOTH nodes and it appeared after `deploy_component restart=rolling replicated=true`.

## To unblock Scenario B

Option 1: Fix `create_authentication_tokens` in the integration test harness to generate encryption keys for Pro nodes.
Option 2: Repro manually on a Fabric cluster following the serent-canopy issue #135 repro steps.

## Test files

- `integrationTests/cluster/issue135-resource-search-after-restart.test.mjs` — Scenario A (passing), Scenario B (`.skip`)
- `integrationTests/cluster/issue135-fixture/` — fixture component (SearchCount resource + ScoreEvidence schema)
- `core/unitTests/resources/indexSearchAfterRestart.test.js` — unit-level negative results
