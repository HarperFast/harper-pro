# Plan: integration test reproducing serent-canopy issue #135

## Goal

Write a multi-node replication-based integration test for Harper Pro that reproduces serent-canopy issue #135 — `tables.X.search` from inside a Resource returns a subset of rows after a Harper restart on a replicated Fabric cluster.

If the bug reproduces in this harness, the test fixes the regression scope at the integration-test layer and gives us a guard for the upstream fix. If it does NOT reproduce here, document what was tried and report back so we can pivot to a different repro vector (e.g., schema-change reindex during rolling restart, replication backlog replay).

The full issue text is at https://github.com/stephengoldberg/serent-canopy/issues/135 — read it first.

## Bug fingerprint (from issue #135)

After a Harper Pro `restart` op (or rolling `deploy_component`) on a 2-node Fabric replicated cluster:

- `SELECT id FROM data.ScoreSnapshot WHERE companyId='…'` via the ops `sql` op → 3 rows (correct).
- `{operation:'search_by_conditions', table:'ScoreEvidence', conditions:[{search_attribute:'snapshotId', search_value:'…'}]}` → 45 rows (correct).
- From inside a custom Resource: `tables.ScoreEvidence.search({ conditions: [{ attribute: 'snapshotId', value: '…' }] })` → 0 rows (wrong).
- Running `{operation:'update', table:'ScoreEvidence', records:[{id:'…'}]}` (a no-op update by id) on each missing row restores visibility until the next restart.

Affected callers in the user's app: `resources/Dashboard.js`, `resources/ResearchEngine.js`, `resources/ScoreSnapshots.js`, `resources/Companies.js` cascade-delete loop. The Companies cascade-delete is the most damaging variant — silent orphans on delete leak storage permanently.

The user's repro checklist:

1. POST `{operation:'restart'}` to one node.
2. Wait ~60s for it to come back up.
3. Hit `/Dashboard/company/<id>` and `/ScoreSnapshots?companyId=<id>` — compare row counts.
4. Compare against `{operation:'sql', sql:'SELECT … FROM data.ScoreSnapshot WHERE companyId=…'}`.
5. If counts diverge: `update` every snapshot row with just `{id}` and re-test — counts should match again.

## What's already ruled out (do NOT redo this work)

Unit tests at `core/unitTests/resources/indexSearchAfterRestart.test.js` already exercise four scenarios in a single Node process, and ALL pass cleanly:

1. Write rows → `resetDatabases()` → search by indexed attribute. Works.
2. Primary store retains rows after `resetDatabases()`. Works.
3. Write rows in a forked child Node process → reader child opens same on-disk DB → search by indexed attribute. Works (real process boundary, fresh rocksdb-js native handles, fresh msgpackr encoder, only shared state is the on-disk RocksDB).
4. Add `@indexed` to an existing attribute (with and without awaiting `indexingOperation`, including a mid-flight `resetDatabases()` interruption that simulates restart-during-reindex). Works.

This means the bug is NOT in:

- `RocksIndexStore.getRange` composite-key encoding (round-trips fine).
- `search.ts:373` regular-index path's transaction handling at the single-process level.
- The `runIndexing` backfill / `lastIndexedKey` resumption (in isolation).
- Basic on-disk-only restart semantics.

The bug almost certainly requires REPLICATION state. Your job is to confirm that by reproducing it in a multi-node harness, or to demonstrate that even multi-node doesn't reproduce it (in which case the cause is narrower — probably the transaction-log replay path on a node that fell behind during a rolling deploy).

## Reference files (read these before writing code)

- `/home/kzyp/dev/harper-pro/integrationTests/cluster/replicationLoad.test.mjs` — canonical multi-node integration test. Use the `NODE_COUNT`, `startHarper`, loopback-address-pool, and `add_node` cluster-connect pattern from `before()` and the `connect nodes` test.
- `/home/kzyp/dev/harper-pro/integrationTests/cluster/clusterShared.mjs` — `sendOperation`, `fetchWithRetry`, `concurrent`. Reuse these.
- `/home/kzyp/dev/harper-pro/integrationTests/cluster/fixture/` — example fixture component (`config.yaml`, `schema.graphql`, `resources.js`). Pattern for deploying a custom Resource via `deploy_component`.
- `/home/kzyp/dev/harper-pro/core/integrationTests/server/crash-replay.test.ts` — single-node SIGKILL+restart pattern using `ctx.harper.process.kill('SIGKILL')` followed by `startHarper(ctx)` to bring the same node back.
- `/home/kzyp/dev/harper-pro/core/integrationTests/utils/harperLifecycle.ts` — `startHarper`/`teardownHarper` API.
- `/home/kzyp/dev/harper-pro/core/resources/search.ts` — the search path. The customIndex/HNSW branch at line 357 was fixed May 5 (commits 972a68742, 5b0125afc) for the same class of bug; the regular-index branch at line 373 was NOT updated. Likely surface for the fix once we have a repro.
- `/home/kzyp/dev/harper-pro/core/resources/RocksIndexStore.ts` — composite-key encoding for the regular index.
- `/home/kzyp/dev/harper-pro/core/unitTests/resources/indexSearchAfterRestart.test.js` — the in-process tests that all pass. Read this to understand what's been ruled out and how the bug is described.

## Required test design

### Critical: exercise the Resource SDK path, not the ops API

The user's bug is specifically that the ops API works correctly but the Resource SDK doesn't. So the test MUST query through the Resource SDK code path. There are two reliable ways to do this:

1. **Deploy a fixture component** with a custom `Resource` class that internally calls `tables.X.search(...)` and returns a result count. Hit it over HTTP from the test. This is the closest analogue to the user's setup (their bug is in `resources/Dashboard.js` calling `tables.ScoreSnapshot.search`).
2. **Hit the auto-generated REST endpoint** on an `@export` table — `GET /TableName?attribute=value` goes through the same Resource code path that `tables.X.search` does internally.

Prefer #1 because it's the exact code path of the user's bug.

The ops API (`search_by_conditions`) is your CORRECTNESS ORACLE — it's what the user's tests showed working correctly. So the assertion shape is:

```
const expected = (await sendOperation(node, { operation: 'search_by_conditions', ... })).length;
const actual   = await getCountViaResourceSDKEndpoint(node);
assert.equal(actual, expected);
```

A failing test means `actual < expected`.

### Test scenarios (in priority order — implement in this order, stop after the first that reproduces)

**Scenario A: write → graceful restart → search (simplest hypothesis)**

1. Start a 2-node cluster (mirror the `before()` setup in `replicationLoad.test.mjs`).
2. Create a table with an `@indexed` attribute via `create_table` on node 0. Let it replicate.
3. Deploy the fixture component (with the custom search-Resource) on both nodes via `deploy_component … replicated=true restart=true`.
4. Insert ~100 rows on node 0 with varying values of the indexed attribute. Wait for replication to drain (poll `describe_table.record_count` on node 1 until it matches).
5. Send `{operation:'restart'}` to node 1 via the ops API; poll its health endpoint until it's back up.
6. Hit the fixture's resource search endpoint on node 1 with each distinct indexed value. Compare each count to a `search_by_conditions` ops call against the same node.
7. Assert equality.

**Scenario B: write → rolling deploy_component restart → search**

Same as A but instead of `{operation:'restart'}`, trigger a rolling redeploy by re-deploying the fixture component with `restart=rolling replicated=true`. This is closer to the user's environmental trigger.

**Scenario C: schema-change reindex during rolling restart**

The user's #135 note says PR #133 (`@indexed createdAt`) is what surfaced the bug. Simulate that:

1. Set up cluster, deploy fixture, write rows with an attribute that is NOT yet indexed.
2. Trigger a schema upgrade that adds `@indexed` to that attribute, replicated across nodes.
3. Before reindex backfill completes, kick a rolling restart on both nodes.
4. After both nodes are back, query via the resource endpoint and compare to `search_by_conditions`.

**Scenario D: SIGKILL one node mid-write, then restart**

Mirrors `crash-replay.test.ts` but in a 2-node cluster. While node 0 is doing replicated writes, SIGKILL node 1. Bring it back. Wait for replication catchup. Query node 1 via the resource endpoint vs ops API.

### Implementation notes

- File path: `/home/kzyp/dev/harper-pro/integrationTests/cluster/issue135-resource-search-after-restart.test.mjs`.
- Fixture: create a new fixture under `integrationTests/cluster/issue135-fixture/` (don't reuse `cluster/fixture/` — it has its own Location/blob schema). The fixture should define a small `@table @export` with an indexed attribute and a custom `Resource` class with a GET handler that calls `tables.X.search` and returns `{ count, ids }`.
- Use `HARPER_NO_FLUSH_ON_EXIT: true` env per `replicationLoad.test.mjs` for faster teardown — but consider WHEN to skip it (scenario D wants normal flush behavior so the SIGKILL is the only data-loss vector).
- Replication catchup polling: use the existing pattern in `replicationLoad.test.mjs:181-198` (poll `search_by_value` retry loop until count converges).
- Restart polling: after sending `{operation:'restart'}`, poll the node's health endpoint with backoff (the operations API URL won't respond during the restart window).
- Test timeout: scale up the `suite('…', { timeout: N })` to ~180-300s if needed.
- Run mode: `npm run test:integration -- integrationTests/cluster/issue135-resource-search-after-restart.test.mjs` from `/home/kzyp/dev/harper-pro/`.

## Acceptance criteria

A successful outcome is ONE of:

1. **A failing test that reproduces the bug** — count via resource SDK is less than count via ops API after restart. The test name and assertion message should clearly identify which scenario (A/B/C/D) reproduced it. Commit it as a `.skip` or `xit` so CI doesn't break, OR commit it as expected-failing with a clear comment that ties to issue #135 — your judgment, lean toward `.skip` with a comment.
2. **A passing test plus a documented finding** — if NONE of A/B/C/D reproduce the bug at the integration-test level, commit the most representative test (probably Scenario B or C) as a permanent regression guard for the working behavior, and write a short summary in the commit message and in this plan file describing what you tried and the implication ("multi-node replication + restart does not reproduce in the integration harness; bug is narrower — likely Fabric-specific replication state or production-load-only").

In either case, run `npm run format:write` and `npm run lint:required` on any new files before committing. Open a PR against `main` from the branch you're on (`test/issue-135-replication-repro`). PR description should:

- Link to serent-canopy issue #135 for context.
- Summarize what scenarios were tried and the result.
- Identify the lower-confidence parts of the test for review attention (fixture design, replication-catchup poll, restart-readiness poll).
- Note this was generated by an agent.

## Pre-flight

Before writing any code:

1. Check the current branch with `git branch --show-current` — you should be on `test/issue-135-replication-repro`. If you're somewhere else, `git checkout test/issue-135-replication-repro`.
2. Read `core/AGENTS.md` and `CONTRIBUTING.md` if either exists at the pro level.
3. Read the issue #135 description in full at the URL above.
4. Read the four scenarios above and confirm the design before writing the fixture.

If anything in this plan is ambiguous or you discover the approach won't work for reasons not anticipated here, STOP and report what you found — don't paper over it.
