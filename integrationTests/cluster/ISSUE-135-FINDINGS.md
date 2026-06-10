# Issue #135 — Integration Test Findings

## What we know

The bug (Resource SDK `tables.X.search` returns subset after Harper restart, ops API returns full set) does NOT reproduce in any of these scenarios:

**Unit test layer (`core/unitTests/resources/indexSearchAfterRestart.test.js`):**

- In-process `resetDatabases()` + search by indexed attribute. **Passes.**
- Real subprocess boundary (writer forks, exits, reader opens same DB). **Passes.**
- Adding `@indexed` to an existing attribute (schema migration), with and without awaiting `indexingOperation`. **Passes.**
- Mid-flight `resetDatabases()` interrupting a schema reindex. **Passes.**

**Integration test layer:**

- Scenario A (`issue135-resource-search-after-restart.test.mjs`): deploy fixture → insert 100 rows on single node → graceful `{operation:'restart'}` → compare `search_by_value` (ops API) vs `/SearchCount?snapshotId=…` (Resource SDK via `tables.ScoreEvidence.search`). **Both return 100. Passes.**
- Scenario B (`issue135-replicated-search-after-restart.test.mjs`): 2-node cluster → insert 50 rows on node 0 → wait for replication to drain to node 1 → restart node 1 → query node 1 via Resource SDK. **Receives full 50 rows. Passes.**

## What the bug must require

Since both single-node restart AND replication-receiving-node restart reproduce cleanly, the issue #135 fingerprint is narrower than expected. Plausible triggers:

- Fabric-specific replication topology (multi-region, mesh of more than 2 nodes).
- Rolling `deploy_component` cycles with active replication backlog.
- The combination of an `@indexed` schema migration (`PR #133` on serent-canopy) + rolling restart, where the new index's backfill is interrupted mid-flight across nodes.
- Production-scale load / concurrent writes that the integration tests don't exercise.

## Companion fix landed

The cluster tests in this PR depended on `add_node_back` being registered on worker threads, which was broken after the operations API moved to main-thread-only (40600bfc4 in core). The companion fix in core (`components/componentLoader.ts`) eagerly requires `serverHelpers/serverUtilities` in worker threads so `server.registerOperation?.({...})` calls from replication and other plugins land in the operation function map. Without that fix, `fullyConnectedReplication.test.mjs`, `replicationLoad.test.mjs`, and Scenario B here all fail with `Operation 'add_node_back' not found and connection was required to sign certificate`.

## Test files

- `integrationTests/cluster/issue135-resource-search-after-restart.test.mjs` — Scenario A (single-node)
- `integrationTests/cluster/issue135-replicated-search-after-restart.test.mjs` — Scenario B (multi-node)
- `integrationTests/cluster/issue135-fixture/` — fixture component (SearchCount resource + ScoreEvidence schema)
- `core/unitTests/resources/indexSearchAfterRestart.test.js` — unit-level negative results

The two integration suites are in separate files because `node --test` runs top-level suites concurrently; colocating them caused cluster setup and single-node restart timing to interfere.

## To reproduce on a real Fabric cluster

Follow the repro steps in serent-canopy issue #135. The bug appears reliably there but not here, which is meaningful negative data for narrowing the root cause.
