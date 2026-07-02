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

| Position | Constant                          |
| -------- | --------------------------------- |
| 0        | `CONFIRMATION_STATUS_POSITION`    |
| 1        | `RECEIVED_VERSION_POSITION`       |
| 2        | `RECEIVED_TIME_POSITION`          |
| 3        | `SENDING_TIME_POSITION`           |
| 4        | `LATENCY_POSITION`                |
| 5        | `RECEIVING_STATUS_POSITION`       |
| 6        | `BACK_PRESSURE_RATIO_POSITION`    |
| 7        | `BLOB_FAILURE_COUNT_POSITION`     |
| 8        | `LAST_BLOB_FAILURE_TIME_POSITION` |
| 9        | `CONNECTION_STATE_POSITION`       |
| 10       | `LAST_LIVENESS_TIME_POSITION`     |
| 11       | `LAST_ERROR_CODE_POSITION`        |
| 12       | `LAST_ERROR_TIME_POSITION`        |

The buffer is 16 `Float64` slots (128 bytes); 0–12 are used, 13–15 are headroom. These are written concurrently by `replicationConnection.ts` without explicit synchronization (single-writer-per-field in practice). Don't introduce read-modify-write patterns on this buffer.

**Connection truth (W1 / harper-pro#431).** Slots 9–12 make the owning worker thread the authoritative source for an outbound subscription's link state, rather than relying solely on the edge-triggered worker→main `postMessage` mirror (`connected-to-node` / `disconnected-from-node`), which desyncs when a terminal/idle state is reached without a `'close'` (open-but-idle wedge, #289/#233). The worker writes `CONNECTION_STATE_CONNECTED` + `LAST_LIVENESS_TIME` on pong and on received data, `CONNECTION_STATE_DOWN` + error on close/`forceReconnect`, and refreshes liveness during a backpressure pause (matching `shouldTerminateIdlePing`'s `pauseReasons` exemption). The main thread reads it via `deriveConnectionTruth` / `readConnectionTruth`: `connected` requires `CONNECTED` **and** fresh liveness (`< LIVENESS_STALE_MS`, derived from `PING_TIMEOUT`), so a worker that died/wedged without writing `DOWN` still reads down once liveness goes stale. `clusterStatus.ts` reports it (authoritative `connected` + `lastConnectionError`); `subscriptionManager.ts → reconcileWorkers` corrects the inferred flag against it, feeding the existing wedge recovery.

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

6. **Keep-alive is measured from byte activity, not a single ping interval.** `shouldTerminateIdlePing` terminates a connection only after no socket bytes have moved in either direction for the full `PING_TIMEOUT`. A bulk transfer — notably the initial clone copy of a large table — makes slow but real progress (the sender's buffer drains in bursts as the peer consumes), so bytes keep moving within the window and it is not killed mid-copy (the old "no bytes since last ping → terminate" heuristic restarted the copy from zero — issue #241). A genuinely dead peer moves no bytes and still trips the timeout — including the case where the sender filled its socket buffer and the `drain` event never fires. The sole exemption is `pauseReasons > 0` (the receiver intentionally stopped reading to drain its own queue): that stall is local and self-clearing, so the caller keeps liveness fresh while paused. That paused window is not left unguarded, though — the byte watchdog is _blind_ while paused (`ws.pause()` freezes `bytesRead`), so a companion **pause-stall watchdog** (`createPauseStallWatchdog`, armed on pause / stopped on resume) takes over, keyed on a local consumer-progress counter (`onCommit` + blob-drain ticks) that keeps advancing while paused. A pause that is making progress re-arms every window; only one with ZERO consumer progress for `PAUSE_STALL_THRESHOLD_MS` (it can never self-clear) forces a reconnect — closing the hole where a leg that died mid-pause (e.g. a base copy stalled at ~100% back-pressure) had no recovery driver at all (harper-pro#466). Relatedly, the receive decode loop in `replicateOverWS` yields the event loop on a time budget (`RECEIVE_YIELD_INTERVAL`) — not only when the consumer queue exceeds `RECEIVE_EVENT_HIGH_WATER_MARK` — so a single large message can't decode in one synchronous turn and starve ping responses (core's `MAX_EVENT_DELAY_TIME` monitor).

7. **The initial bulk clone copy is resumable (PK cursor).** When a follower requests a full copy (`startTime: 0`), the leader sends `COPY_START{copyStartTime}`, walks each table's primary store in key order, flushes a checkpoint transaction every `COPY_CHECKPOINT_RECORDS` (timed at `copyStartTime` so the persisted `seqId` stays pinned there, never a record's `localTime`), and sends `COPY_COMPLETE` at the end. The follower persists a cursor `{copyStartTime, currentTable, afterKey}` under `dbisDB` key `Symbol.for('copyCursor')` — but only in the `end_txn` `onCommit`, **after** the batch commits, so the cursor can never get ahead of committed data (a resume re-copies a few records idempotently but never skips). On reconnect, `sendSubscriptionRequestUpdate` reads the cursor and sends it as `copyResume` on the subscription request (overriding the persisted `seqId`, which alone would skip the un-copied tables); the leader skips tables before `currentTable` (stable iteration order ⇒ already committed) and resumes `currentTable` after `afterKey`. `COPY_COMPLETE` clears the cursor so subsequent connections resume normally from `seqId`. Before this, an interrupted copy restarted from zero and never converged for a large table (issue #241).

8. **Blob durability watermark: holds on a local/transient gap, advances past a source-missing (ENOENT) one.** Records commit (== become visible) without waiting on their blobs; the persisted resume cursor instead tracks `lastDurableSequenceId`, which only advances to a committed sequence once that sequence's blobs (and all earlier ones) are durably saved (the `.finally` watermark advance + the `onCommit` clamp, both gated on `!hasBlobGap`). A blob save failure in `receiveBlobs` is classified. A **local/transient** fault (receiver `createWriteStream` ENOENT, disk full, mid-stream timeout) sets `hasBlobGap`, pinning the watermark so a reconnect re-streams and re-saves the blob — no silent loss (#368/#386). A **source-reported PERMANENT** failure — the sender's `sendBlobs` catch forwarded a `BLOB_CHUNK` `error` marker with `errorCode: 'ENOENT'` because the blob is gone at the origin (evicted/expired) — is unrecoverable: re-streaming reproduces it, so holding would wedge the connection forever. The receiver instead logs it loudly (`cluster_status.blobReplicationFailures` + a per-blob "advancing the resume cursor past it" error), advances, and leaves the diverged record for proactive blob backfill (#388). Classification is deliberately narrow (`isPermanentSourceBlobErrorCode` = ENOENT only): a transient sender fault (EIO, EMFILE, timeout) or an older sender that doesn't forward `errorCode` stays unmarked, so it HOLDS like a local gap and a reconnect retries — never silently skipping a recoverable blob. The trigger is set on the destroy error via `markSourceBlobUnavailable`; the save `.catch` keys on `isUnrecoverableSourceBlobError`. See harper-pro#403.

9. **Receive-side blob streams are created with a no-op `'error'` listener (`createBlobReceiveStream`).** A `blobsInFlight` PassThrough can be left _orphaned_ — created when a chunk arrives or a record is applied, but never wired to `saveBlob`'s pipeline because the apply path threw first (observed in the field as app code calling a non-existent `blob.save()` on a v4→v5-migrated record, harper-pro#1337). The `blobsTimer` sweep later `destroy(err)`s such a stream; with no `'error'` listener Node promotes that to a process-level `uncaughtException` (the field symptom: a storm of "Timeout waiting for blob stream …" uncaughtExceptions). Attaching the listener at creation makes teardown of an orphaned stream a no-op. `saveBlob`'s pipeline adds its own handling for wired streams, so real save errors are still classified by item 8 — this only suppresses the unhandled-error crash for streams that never got a consumer.

10. **The reconcile recovers two distinct wedge shapes, on two signals.** `subscriptionManager.reconcileWorkers` (main thread, every `RECONCILE_INTERVAL_MS`) is the independent safety net behind the per-connection recovery paths. (a) `findStaleNodeUrls` rebinds entries whose worker died. (b) `findWedgedNodeUrls` re-drives `connected:false` entries that wedged on a _live_ worker with no pending retry (`re-subscribe`; the #420/#424/#289 family). (c) `findStalledReceivingNodeUrls` re-drives `connected:true` entries stuck `RECEIVING_STATUS_RECEIVING` with no apply progress (the ping-alive base-copy wedge — keepalive pings keep the byte watchdog alive and the received-_version_ is frozen mid-copy, so neither (b) nor the byte watchdog sees it; harper-pro#453). Recovery for (c) is `forceReconnectToNode` (worker-side `connection.forceReconnect()`) **not** a re-subscribe — `getSubscriptionConnection` reuses a still-`connected` connection unchanged. The progress signal is `RECEIVED_TIME` read from the process-shared status buffer on the _main_ thread (`getReplicationSharedStatus`, as `cluster_status` does): it advances per applied copy record even while version is suppressed, so a slow-but-progressing copy keeps resetting the stall clock. Threshold (`RECEIVE_STALL_THRESHOLD_MS`, 15 min) is far longer than the worker-local copy-progress watchdog (#454, ~120s) and byte-idle `COPY_TIMEOUT` (300s), so (c) only acts if those fail; `receiveStallReconnectAt` gates re-drives to once-per-resumed-progress so a caught-up/cosmetically-`Receiving` connection is not churned.

11. **Outbound-subscription reconnect recovery is layered (belt-and-suspenders), and every layer must self-heal a never-`open`ed connection.** A `(peer, db)` subscription that drops or never connects must always end up with _some_ pending recovery; three independent drivers cover this: (a) the close handler / `forceReconnect` re-drive `connect()` through `scheduleReconnect()` with backoff; (b) the receive watchdog calls `forceReconnect()` on an open-but-idle socket that never emits `'close'` — and, because that byte watchdog is suspended while the socket is paused for back-pressure (`bytesRead` frozen), a **pause-stall watchdog** companion (`createPauseStallWatchdog`, item 6) covers the paused window by watching consumer progress instead, so a leg that dies mid-pause still reconnects; (c) the main-thread reconcile (`findWedgedNodeUrls` → `reconcileWorkers`) re-drives an entry that has been not-`connected:true` past `WEDGE_RECONCILE_THRESHOLD_MS`. The trap (harper-pro#466): `connect()` `await`s `createWebSocket()`, which can **reject before any socket/listener exists** (no valid replication cert yet, or `SNICallback.initialize()` failing while a freshly-restarted peer rebuilds its TLS secure contexts). Because the re-drive is `setTimeout(() => this.connect())` with no `.catch()`, that rejection escaped as an unhandled rejection and the only pending retry vanished — so `connect()` now catches it and routes back through `scheduleReconnect()` (`reconnectScheduled` stays true with a fresh timer; it is cleared only on the _success_ path after `this.socket` is assigned). Two subtleties the reconcile backstop must respect: a **never-`open`ed** entry has `connected` still `undefined` (not `false`) and no `disconnectedAt` (only `disconnectedFromNode` stamps that), so the wedge predicate keys on `connected !== true` with `downSince = disconnectedAt ?? createdAt` (createdAt stamped at entry creation); and re-posting `subscribe-to-node` only re-`subscribe()`s a still-`isReusableConnection` cached connection — it does **not** reconnect it — so the reconcile sets `forceReconnect:true`, applied by `subscribeToNode` **only to a reused connection** (a freshly-created one already called `connect()`), and only to a database that independently passes the wedge predicate (the URL is flagged because _some_ db is wedged; a healthy or grace-period sibling db must be left alone). See harper-pro#420/#424/#289/#233/#466.

---

## Tests

**Integration tests** live in `../integrationTests/cluster/`:

| File                                 | Purpose                                                 |
| ------------------------------------ | ------------------------------------------------------- |
| `clusterShared.mjs`                  | Shared fixture/helper (cluster boot, node setup)        |
| `fullyConnectedReplication.test.mjs` | Full-mesh topology                                      |
| `replicationTopology.test.mjs`       | Dynamic membership changes                              |
| `replicationLoad.test.mjs`           | Concurrent-write load                                   |
| `excludeTablesReplication.test.mjs`  | Per-route `excludeTables` bridge migration (issue #239) |

Most replication behavior is exercised via integration tests that spin up multi-node clusters. A few function-level invariants that don't need a cluster live in `../unitTests/replication/` (e.g. `listenerLifecycle.test.mjs`, `pingKeepalive.test.mjs`).

---

## "Where is X" cheat sheet

| Question                                  | Where                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Where does a remote message get decoded?  | `replicationConnection.ts → replicateOverWS`                                                                |
| Where do cache-miss fetches pick a peer?  | `replicator.ts → Replicator.load` (declared inside `setReplicator`)                                         |
| Where is the connection retry loop?       | `replicationConnection.ts → NodeReplicationConnection` (uses `INITIAL_RETRY_TIME`)                          |
| Where is mTLS configured?                 | `replicator.ts → buildReplicationMtlsConfig`                                                                |
| Where is a new cluster member added?      | `setNode.ts` (the whole file is one operation)                                                              |
| Where are protocol message types defined? | `replicationConnection.ts` — top-level consts (`SUBSCRIPTION_REQUEST` … `SUBSCRIPTION_UPDATE`)              |
| Where is `hdb_nodes` schema?              | `knownNodes.ts → getHDBNodeTable`                                                                           |
| What does `cluster_status` return?        | `clusterStatus.ts` (82 lines, whole file)                                                                   |
| Where is per-route table exclusion logic? | `knownNodes.ts → getExcludedTablesForRouteEntries`; threaded via `subscriptionManager.ts → routeReplicates` |
