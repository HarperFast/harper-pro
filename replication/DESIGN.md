# replication/ — Navigation Guide

Real-time, peer-to-peer replication of table data across cluster nodes via persistent WebSocket connections. Implements eventual consistency: when a local transaction commits, the audit records are forwarded asynchronously to peers.

**Read this when:** you're touching cluster sync, debugging missed writes, JWT/cluster auth, latency-based node selection, or blob transfer between nodes.

**Integration boundary with core:** replication hooks into core's table resource layer — a `Replicator` class is installed as a `source` of the table (`table.sourcedFrom(class Replicator extends Resource {...})`). When a local cache miss occurs, the Replicator picks the lowest-latency peer and fetches. Core's audit store (`core/resources/auditStore.ts`) and node-id mapping (`core/resources/nodeIdMapping.ts`) are the two data structures replication reads.

---

## Files (6 total, ~4200 lines)

| File                       | Lines | Purpose                                                                                                                                                                                                               |
| -------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replicationConnection.ts` | 2288  | The protocol engine. Defines `NodeReplicationConnection`, encodes/decodes the binary frame format, drives audit-record forwarding, manages blobs, and writes shared latency/back-pressure counters. **The big file.** |
| `replicator.ts`            | 656   | Setup module: `start()`, per-database/per-table `Replicator` resource class, retrieval-connection pool, operation forwarding, mTLS config.                                                                            |
| `subscriptionManager.ts`   | 568   | Main-thread orchestration. Delegates subscription work to worker threads; routes around disconnects.                                                                                                                  |
| `setNode.ts`               | 313   | Cluster member operations — add/remove nodes, CSR signing, TLS certificate negotiation.                                                                                                                               |
| `knownNodes.ts`            | 297   | Node registry (`hdb_nodes` system table) + shared-memory `Float64Array` status buffers (latency, confirmation, back-pressure).                                                                                        |
| `clusterStatus.ts`         | 82    | Read-only status reporting for `cluster_status` operation.                                                                                                                                                            |

---

## Key abstractions

### `NodeReplicationConnection` (replicationConnection.ts:197)

A persistent connection to one remote node. Owns the WebSocket lifecycle, reconnection, latency tracking, and per-subscription state. **Inspect this when debugging connection drops or auth failures** (see issue #135 lineage on JWT/cluster auth).

### `replicateOverWS(ws, options, authorization)` (replicationConnection.ts:339)

The protocol decoder. Reads incoming binary commands (constants at lines 63–86):

| Command                                    | Value     | Meaning                                   |
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

The authorization parameter is a **promise that may resolve asynchronously**; on rejection the socket closes without a DISCONNECT frame (relevant to JWT failure flows).

### `Replicator extends Resource` (replicator.ts:334)

A `Resource` class installed as a `source` of a table. Its `static async load(entry)` method (replicator.ts:376) picks the lowest-latency available node for cache-miss fetches.

### Shared status buffers (knownNodes.ts:63–75)

Per (database, remote_node) pair: an mmap-backed `Float64Array` shared across threads, used to avoid IPC for hot-path status updates. Positions are defined in `replicationConnection.ts` lines 78–84:

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

### `hdb_nodes` system table (knownNodes.ts:18–61)

Schema: `name` (PK), `subscriptions[]`, `system_info`, `url`, `routes`, `ca`, `ca_info`, `replicates`, `revoked_certificates`. Subscription updates trigger `subscribeToNodeUpdates` (knownNodes.ts:77), which fans out to `monitorNodeCAs` → refresh `replicationCertificateAuthorities` (replicator.ts:56).

---

## Subsystems

**Connection management** — `NodeReplicationConnection.connect()` (replicationConnection.ts:197+), `subscriptionManager.startOnMainThread()`. Dial/retry, thread-pool delegation, recovery on disconnect.

**Binary protocol** — `replicateOverWS` (replicationConnection.ts:339+); command constants at lines 63–86; msgpack body; back-pressure ratio recomputed every 30s (line 434).

**Data propagation** — Audit-record iteration → forwarding; blob streaming with concurrency cap `MAX_OUTSTANDING_BLOBS_BEING_SENT` (replicationConnection.ts:455); commit confirmation batched on `COMMITTED_UPDATE_DELAY = 2ms` (line 101).

**Latency awareness** — Ping every `PING_INTERVAL = 30s` (line 102); latency captured on pong; `Replicator.load()` (replicator.ts:376) routes cache-miss fetches to the lowest-latency node.

**Node discovery & TLS** — `hdb_nodes` subscriptions, `setNode.ts` for member ops, `buildReplicationMtlsConfig()` (replicator.ts:64), `monitorNodeCAs()` (replicator.ts:268).

---

## Non-obvious behaviors

1. **Auth failures don't send DISCONNECT.** When the `authorization` promise rejects in `replicateOverWS`, the connection closes with "Unauthorized" but no DISCONNECT frame is sent — the client is expected to retry. This is the lineage of JWT/cluster auth bugs (issue #135).

2. **Origin loop prevention via delayed sequence updates.** A node receiving its own message (checked against `remoteToLocalNodeId`) skips local processing but still forwards. To avoid feedback loops, the sequence-update emit is delayed by `SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY = 300ms` (replicationConnection.ts:97).

3. **Blob back-pressure & timeout.** Blobs time out after `blobTimeout` (default 120s); concurrent sends are capped at `MAX_OUTSTANDING_BLOBS_BEING_SENT = 5`; back-pressure ratio (computed every 30s) tells senders to pause. If you're seeing large-data replication hangs, look here first.

4. **Shared-buffer concurrency.** The Float64Array status buffers are touched from multiple threads with no lock. Treat them as eventually consistent; use the callback param of `subscribeToNodeUpdates` if you need notification.

---

## Tests

**Integration tests** live in `../integrationTests/cluster/`:

| File                                 | Purpose                                          |
| ------------------------------------ | ------------------------------------------------ |
| `clusterShared.mjs`                  | Shared fixture/helper (cluster boot, node setup) |
| `fullyConnectedReplication.test.mjs` | Full-mesh topology                               |
| `replicationTopology.test.mjs`       | Dynamic membership changes                       |
| `replicationLoad.test.mjs`           | Concurrent-write load                            |

There is no dedicated `unitTests/replication/` directory — replication is exercised entirely via integration tests that spin up multi-node clusters.

---

## "Where is X" cheat sheet

| Question                                  | File:line                                             |
| ----------------------------------------- | ----------------------------------------------------- |
| Where does a remote message get decoded?  | `replicationConnection.ts:339` (`replicateOverWS`)    |
| Where do cache-miss fetches pick a peer?  | `replicator.ts:376` (`Replicator.load`)               |
| Where is the connection retry loop?       | `replicationConnection.ts:192` (`INITIAL_RETRY_TIME`) |
| Where is mTLS configured?                 | `replicator.ts:64` (`buildReplicationMtlsConfig`)     |
| Where is a new cluster member added?      | `setNode.ts:1` (whole file is one function)           |
| Where are protocol message types defined? | `replicationConnection.ts:63–86`                      |
| Where is `hdb_nodes` schema?              | `knownNodes.ts:18–61`                                 |
| What does `cluster_status` return?        | `clusterStatus.ts` (82 lines, whole file)             |
