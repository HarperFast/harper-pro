# replication/ — Navigation Guide

Real-time, peer-to-peer replication of table data across cluster nodes via persistent WebSocket connections. Implements eventual consistency: when a local transaction commits, the audit records are forwarded asynchronously to peers.

**Read this when:** you're touching cluster sync, debugging missed writes, JWT/cluster auth, latency-based node selection, or blob transfer between nodes.

**Integration boundary with core:** replication hooks into core's table resource layer — a `Replicator` class is installed as a `source` of the table (`table.sourcedFrom(class Replicator extends Resource {...})`). When a local cache miss occurs, the Replicator picks the lowest-latency peer and fetches. Core's audit store (`core/resources/auditStore.ts`) and node-id mapping (`core/resources/nodeIdMapping.ts`) are the two data structures replication reads.

> **Navigation convention.** Code is referenced by **symbol name** (class, function, exported const). Use your editor's go-to-symbol or `grep -n '<name>' replication/<file>` to jump. Line numbers drift; symbols don't.

---

## Files (6 total, ~4200 lines)

| File                       | Purpose                                                                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replicationConnection.ts` | The protocol engine. Defines `NodeReplicationConnection`, encodes/decodes the binary frame format, drives audit-record forwarding, manages blobs, and writes shared latency/back-pressure counters. **The big file.** |
| `replicator.ts`            | Setup module: `start()`, per-database/per-table `Replicator` resource class, retrieval-connection pool, operation forwarding, mTLS config.                                                                            |
| `subscriptionManager.ts`   | Main-thread orchestration. Delegates subscription work to worker threads; routes around disconnects.                                                                                                                  |
| `setNode.ts`               | Cluster member operations — add/remove nodes, CSR signing, TLS certificate negotiation.                                                                                                                               |
| `knownNodes.ts`            | Node registry (`hdb_nodes` system table) + shared-memory `Float64Array` status buffers (latency, confirmation, back-pressure).                                                                                        |
| `clusterStatus.ts`         | Read-only status reporting for `cluster_status` operation.                                                                                                                                                            |

---

## Key abstractions

### `NodeReplicationConnection` (`replicationConnection.ts`)

A persistent connection to one remote node. Owns the WebSocket lifecycle, reconnection (initial delay `INITIAL_RETRY_TIME`), latency tracking, and per-subscription state. **Inspect this when debugging connection drops or auth failures** (see issue #135 lineage on JWT/cluster auth).

### `replicateOverWS(ws, options, authorization)` (`replicationConnection.ts`)

The protocol decoder. Reads incoming binary commands — each is a top-level named const in the same file:

| Command constant                           | Value     | Meaning                                   |
| ------------------------------------------ | --------- | ----------------------------------------- |
| `SUBSCRIPTION_REQUEST`                     | 129       | Client wants to subscribe to a table      |
| `RESIDENCY_LIST`                           | 130       | Negotiate which records each node holds   |
| `TABLE_FIXED_STRUCTURE`                    | 132       | Schema sync                               |
| `GET_RECORD` / `GET_RECORD_RESPONSE`       | 133 / 134 | Cache-miss fetch                          |
| `OPERATION_REQUEST` / `OPERATION_RESPONSE` | 136 / 137 | Forwarded operations                      |
| `NODE_NAME` / `NODE_NAME_TO_ID_MAP`        | 140 / 141 | Identity exchange                         |
| `DISCONNECT`                               | 142       | Graceful close (not used on auth failure) |
| `SEQUENCE_ID_UPDATE`                       | 143       | Audit sequence cursor                     |
| `COMMITTED_UPDATE`                         | 144       | Confirm-on-commit                         |
| `DB_SCHEMA`                                | 145       | Database schema replication               |
| `BLOB_CHUNK`                               | 146       | Blob bytes                                |
| `SUBSCRIPTION_UPDATE`                      | 147       | Audit record forwarded to subscribers     |

The `authorization` parameter is a **promise that may resolve asynchronously**; on rejection the socket closes without a DISCONNECT frame (relevant to JWT failure flows).

### `Replicator extends Resource` (`replicator.ts`)

A `Resource` class installed as a `source` of a table. Declared inside `setReplicator()` and passed to `table.sourcedFrom(...)`. Its `static async load(entry)` method picks the lowest-latency available node for cache-miss fetches.

### Shared status buffers (`getReplicationSharedStatus` in `knownNodes.ts`)

Per (database, remote_node) pair: an mmap-backed `Float64Array` shared across threads, used to avoid IPC for hot-path status updates. Position constants live in `replicationConnection.ts`:

| Position | Constant                       |
| -------- | ------------------------------ |
| 0        | `CONFIRMATION_STATUS_POSITION` |
| 1        | `RECEIVED_VERSION_POSITION`    |
| 2        | `RECEIVED_TIME_POSITION`       |
| 3        | `SENDING_TIME_POSITION`        |
| 4        | `LATENCY_POSITION`             |
| 5        | `RECEIVING_STATUS_POSITION`    |
| 6        | `BACK_PRESSURE_RATIO_POSITION` |

These are written concurrently by `replicationConnection.ts` without explicit synchronization. Don't introduce read-modify-write patterns on this buffer.

### `hdb_nodes` system table (`getHDBNodeTable` in `knownNodes.ts`)

Schema (defined in that function): `name` (PK), `subscriptions[]`, `system_info`, `url`, `routes`, `ca`, `ca_info`, `replicates`, `revoked_certificates`, plus `__createdtime__` / `__updatedtime__`. Subscription updates flow through `subscribeToNodeUpdates`, which fans out to `monitorNodeCAs` → refresh `replicationCertificateAuthorities` (exported from `replicator.ts`).

---

## Subsystems

**Connection management** — `NodeReplicationConnection.connect()` (`replicationConnection.ts`), `subscriptionManager.startOnMainThread()`. Dial/retry, thread-pool delegation, recovery on disconnect.

**Binary protocol** — `replicateOverWS` (`replicationConnection.ts`); command constants are the `*_REQUEST` / `*_UPDATE` / `*_RESPONSE` consts at module top; msgpack body; back-pressure ratio recomputed on `BACK_PRESSURE_INTERVAL` (30 s).

**Data propagation** — Audit-record iteration → forwarding; blob streaming with concurrency cap `MAX_OUTSTANDING_BLOBS_BEING_SENT` (declared inside `replicateOverWS`); commit confirmation batched on `COMMITTED_UPDATE_DELAY` (2 ms).

**Latency awareness** — Ping every `PING_INTERVAL` (default 30 s, `replication.pingInterval`); a connection with no socket activity for `PING_TIMEOUT` (default 2× interval, `replication.pingTimeout`) is terminated; latency captured on pong; `Replicator.load()` routes cache-miss fetches to the lowest-latency node.

**Node discovery & TLS** — `hdb_nodes` subscriptions, `setNode.ts` for member ops, `buildReplicationMtlsConfig()` (`replicator.ts`), `monitorNodeCAs()` (`replicator.ts`).

---

## Non-obvious behaviors

1. **Auth failures don't send DISCONNECT.** When the `authorization` promise rejects in `replicateOverWS`, the connection closes with "Unauthorized" but no DISCONNECT frame is sent — the client is expected to retry. This is the lineage of JWT/cluster auth bugs (issue #135).

2. **Origin loop prevention via delayed sequence updates.** A node receiving its own message (checked against `remoteToLocalNodeId`) skips local processing but still forwards. To avoid feedback loops, the sequence-update emit is delayed by `SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY` (300 ms; in `replicationConnection.ts`).

3. **Blob back-pressure & timeout.** Blobs time out after `blobTimeout` (default 120s); concurrent sends are capped at `MAX_OUTSTANDING_BLOBS_BEING_SENT = 5`; back-pressure ratio (computed every `BACK_PRESSURE_INTERVAL`) tells senders to pause. If you're seeing large-data replication hangs, look here first.

4. **Shared-buffer concurrency.** The Float64Array status buffers are touched from multiple threads with no lock. Treat them as eventually consistent; use the callback param of `subscribeToNodeUpdates` if you need notification.

5. **Per-route table exclusion (`excludeTables`).** Route entries in `sendsTo`/`receivesFrom` can specify `excludeTables: ['hdb_nodes']` to prevent specific tables from crossing the wire. Three layers enforce this: (a) subscriber omits them from SUBSCRIPTION_REQUEST (in `sendSubscriptionRequestUpdate`); (b) sender skips their audit records before streaming (in `sendAuditRecord`); (c) receiver drops any that arrive (in the incoming message loop). Route config `routeReplicates` is threaded from `subscriptionManager.ts` onto `nodeSubscriptions` objects so static-route exclusions are available inside HTTP worker threads where `replicateOverWS` runs. Primary use case: v4→v5 migration bridges that share `system` database users/roles but must keep per-cluster `hdb_nodes` topology tables isolated.

6. **Keep-alive is measured from byte activity, not a single ping interval.** `shouldTerminateIdlePing` terminates a connection only after no socket bytes have moved in either direction for the full `PING_TIMEOUT`. A bulk transfer — notably the initial clone copy of a large table — makes slow but real progress (the sender's buffer drains in bursts as the peer consumes), so bytes keep moving within the window and it is not killed mid-copy (the old "no bytes since last ping → terminate" heuristic restarted the copy from zero — issue #241). A genuinely dead peer moves no bytes and still trips the timeout — including the case where the sender filled its socket buffer and the `drain` event never fires. The sole exemption is `pauseReasons > 0` (the receiver intentionally stopped reading to drain its own queue): that stall is local and self-clearing, so the caller keeps liveness fresh while paused. Relatedly, the receive decode loop in `replicateOverWS` yields the event loop on a time budget (`RECEIVE_YIELD_INTERVAL`) — not only when the consumer queue exceeds `RECEIVE_EVENT_HIGH_WATER_MARK` — so a single large message can't decode in one synchronous turn and starve ping responses (core's `MAX_EVENT_DELAY_TIME` monitor).

6. **The initial bulk clone copy is resumable (PK cursor).** When a follower requests a full copy (`startTime: 0`), the leader sends `COPY_START{copyStartTime}`, walks each table's primary store in key order, flushes a checkpoint transaction every `COPY_CHECKPOINT_RECORDS` (timed at `copyStartTime` so the persisted `seqId` stays pinned there, never a record's `localTime`), and sends `COPY_COMPLETE` at the end. The follower persists a cursor `{copyStartTime, currentTable, afterKey}` under `dbisDB` key `Symbol.for('copyCursor')` — but only in the `end_txn` `onCommit`, **after** the batch commits, so the cursor can never get ahead of committed data (a resume re-copies a few records idempotently but never skips). On reconnect, `sendSubscriptionRequestUpdate` reads the cursor and sends it as `copyResume` on the subscription request (overriding the persisted `seqId`, which alone would skip the un-copied tables); the leader skips tables before `currentTable` (stable iteration order ⇒ already committed) and resumes `currentTable` after `afterKey`. `COPY_COMPLETE` clears the cursor so subsequent connections resume normally from `seqId`. Before this, an interrupted copy restarted from zero and never converged for a large table (issue #241).

---

## Tests

**Integration tests** live in `../integrationTests/cluster/`:

| File                                   | Purpose                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| `clusterShared.mjs`                    | Shared fixture/helper (cluster boot, node setup)         |
| `fullyConnectedReplication.test.mjs`   | Full-mesh topology                                       |
| `replicationTopology.test.mjs`         | Dynamic membership changes                               |
| `replicationLoad.test.mjs`             | Concurrent-write load                                    |
| `excludeTablesReplication.test.mjs`    | Per-route `excludeTables` bridge migration (issue #239)  |

Most replication behavior is exercised via integration tests that spin up multi-node clusters. A few function-level invariants that don't need a cluster live in `../unitTests/replication/` (e.g. `listenerLifecycle.test.mjs`, `pingKeepalive.test.mjs`).

---

## "Where is X" cheat sheet

| Question                                  | Where                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Where does a remote message get decoded?  | `replicationConnection.ts → replicateOverWS`                                                   |
| Where do cache-miss fetches pick a peer?  | `replicator.ts → Replicator.load` (declared inside `setReplicator`)                            |
| Where is the connection retry loop?       | `replicationConnection.ts → NodeReplicationConnection` (uses `INITIAL_RETRY_TIME`)             |
| Where is mTLS configured?                 | `replicator.ts → buildReplicationMtlsConfig`                                                   |
| Where is a new cluster member added?      | `setNode.ts` (the whole file is one operation)                                                 |
| Where are protocol message types defined? | `replicationConnection.ts` — top-level consts (`SUBSCRIPTION_REQUEST` … `SUBSCRIPTION_UPDATE`) |
| Where is `hdb_nodes` schema?              | `knownNodes.ts → getHDBNodeTable`                                                              |
| What does `cluster_status` return?        | `clusterStatus.ts` (82 lines, whole file)                                                      |
| Where is per-route table exclusion logic? | `knownNodes.ts → getExcludedTablesForRouteEntries`; threaded via `subscriptionManager.ts → routeReplicates` |
