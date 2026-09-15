# Cluster record locks: the successor-freshness barrier (harper#2542's transport half, inside harper-pro#822)

Design note for the harper-pro half of `docs/record-lock-ownership.md` §7, now that harper#2613
has merged. Core owns delegation lineage: a clean `lockRelease` carries an inherited
`{originNodeName -> origin-log position}` dependency set, the home merges the release entry's own
position into it, and the next grant returns the merged set (or `null`, a recovery marker). Core
then requires the transport to make that set true locally before the grant may admit:

```ts
establishLockFreshness(
  database: string, table: string, key: any, dependencies: LockDependencySet | null
): Promise<LockDependencySet | void>;
```

(`core/resources/recordLockCoordinator.ts:281-286`.) It is a **required** method, so harper-pro no
longer compiles against core until it exists — the same shape of forced update harper#2498 caused
when `epoch()` became `homeMap()`.

Two modes:

| `dependencies` | Meaning | Obligation |
| --- | --- | --- |
| an array | exact clean-handoff lineage | every named `(origin, position)` must be **applied and visible** locally before this call resolves; the return value is ignored |
| `null` | recovery marker (no retained lineage) | drain inbound replication from **every reachable member** to the position each held at grant time, and **return** the positions established, so the delegation carries them onward |

Core bounds the call with the caller's own `lock()` deadline (`#establishFreshness`,
`recordLockCoordinator.ts:1674-1712`), races it against a recall of the pending grant, and turns a
rejection into the retryable 503 the branch already uses. The race does **not** cancel the
transport's promise: a waiter the transport leaves behind after core has given up is the
transport's leak, so every wait here has its own bound and its own teardown.

## Revision history

- **Round 1 — `better-alternative-exists`, adopted.** The first cut evaluated the recovery marker
  against the position the *local inbound stream* held at grant time. The counterexample holds:
  after a receiver restart `received[A] === applied[A] === 0` before any frame arrives, so a
  recovery barrier measured against the local tail passes at once while a reachable A holds
  committed writes it has not yet delivered. Also adopted: the unbounded-waiter leak, the
  disabled-path cost of an ungated watermark write, an unvalidated `REMOTE_SEQUENCE_UPDATE` float,
  and cursors that advance across records the sender skips for an unsubscribed table.
- **Round 2 — `better-alternative-exists`, adopted.** Round 1's response kept a `(database, peer)`
  slot, mirrored two `Float64` writes for tear detection, polled every waiter at 100 Hz, and
  recommended a native "last appended key" for recovery. All four were wrong on the facts:
  (i) `Atomics` **does** work on a `BigUint64Array` view over `getUserSharedBuffer()`'s native
  mapping across worker threads — probed live on the pinned rocksdb-js 2.9.0: a worker read back
  the exact bit pattern of `1789480100774.2732` — so the mirror scheme (which a hybrid tear can
  defeat near a low-word rollover) is replaced by one atomic slot carrying the float's bits;
  (ii) a peer's stream can relay other origins, so progress keyed by *peer* is not progress for
  the *origin* named in a dependency — publication is now keyed by authenticated **origin**;
  (iii) a 100 Hz scan over abandoned waiters can starve the very apply loop it waits on —
  waiters are now indexed by origin and threshold and woken by the publication itself;
  (iv) "last appended key" is not a usable target under commit-order appends (key 101 appends,
  then key 100; a head of 100 is satisfied before 100 is applied) — the recommendation moves to
  a marker write. Round 2 upheld the layer split and failing recovery closed.

## What harper-pro has to build on

1. **A received watermark already exists.** `RECEIVED_VERSION_POSITION` (slot 1 of the
   per-`(database, peer)` shared status buffer) is the highest origin transaction-log key seen from
   that peer. Since harper-pro#790 it is in the **transaction-log-key** domain — the same domain
   core stamps on a control entry (`Table.ts:5803-5846`, `position = txnTime`) and hands back as
   `event.timestamp` on apply — so a dependency position and a published position are comparable.
2. **It is advanced at decode time, not at apply time.** `replicationConnection.ts:6505-6511` sets
   it inside the decode loop, before the event reaches the apply queue. It answers "received",
   which is strictly weaker than the "applied and visible" core asks for. It is telemetry, and
   DESIGN.md's slot map says so; nothing here promotes it.
3. **Apply-visibility is observed, but only in a closure.** The per-batch `end_txn`'s `onCommit`
   sets `committedSequence` with the comment "Commit == visibility"
   (`replicationConnection.ts:6666-6669`). Nothing publishes it outside the connection.
4. **Every committed frame names its origin.** A frame is one origin transaction: its leading
   float is that origin's log key (`frameTxnLogKey`, `replicationConnection.ts:6190`) and each
   record's `nodeId` resolves to a local id (`localSourceNodeId`, `:6388`) and from there to a
   name through the cached inverse map (`getNodeNameForId`, `nodeIdMapping.ts:152`). Relayed
   frames carry the *origin's* key (DESIGN.md item 18), so a stream from peer A can deliver
   B-keyed frames; the origin is known per frame regardless of the path.
5. **There is no head-read on the transaction log**, and **log entries are appended in commit
   order, not timestamp order.** `RocksTransactionLogStore.getKeys()` is a `return []` stub;
   rocksdb-js `docs/transaction-log.md` §"Reading The Transaction Log" states that a transaction
   claims its key from the process-wide monotonic clock at construction and is appended at
   commit, so a later-constructed entry can precede an earlier one in the file and on the wire.
   No "highest key" or "last key" is an append-order head.
6. **The shared buffer is native memory, one writer per stream, and `Atomics`-addressable.**
   `getUserSharedBuffer` returns a plain `ArrayBuffer` over a native mapping shared by every
   thread of the process; `Atomics.store`/`load` on a `BigUint64Array` view of it is an aligned
   64-bit atomic across those threads (probed, see round 2). `NodeReplicationConnection` retires a
   superseded session before installing a socket (DESIGN.md item 15), so one apply loop writes a
   given stream's frames at a time; two streams can deliver the same origin (a direct
   subscription and a relay, during a topology change), and a monotonic `max` is safe across them
   because each delivers that origin's log as an append-order prefix from its own cursor.

## Chosen implementation

**Publish apply-visible progress per authenticated origin, atomically; evaluate clean lineage
against it with event-driven, bounded waiters; fail recovery closed.**

- **The applied slot is per `(database, origin)`, one atomic 64-bit word.** Slot 31 of the
  buffer `getReplicationSharedStatus(auditStore, database, originName)` resolves — the same
  accessor, keyed by origin rather than by the peer whose socket delivered the frame. It holds
  the IEEE-754 bit pattern of the highest applied log key for that origin, stored and loaded
  with `Atomics` through a `BigUint64Array` view and reinterpreted through one preallocated
  `Float64Array`/`BigUint64Array` scratch pair; zero bits mean "nothing published". Slot 32
  carries a publication generation, bumped by `clearReplicationSharedStatus` and the clone-attempt
  reset alongside the received watermark, so a retired session cannot re-stamp progress after a
  reset (DESIGN.md item 15 accepts that re-stamp for telemetry; an admission fence cannot).
  `REPLICATION_SHARED_STATUS_SLOTS` grows from 32 to 40. Because the accessor keys a *node name*,
  an origin that is also a direct peer shares the buffer its connection already uses — slots 31
  and 32 belong to this feature alone, so nothing else reads or writes them.
- **Who writes it, and when.** The apply loop's data-frame `end_txn` `onCommit`, at its end, after
  every existing commit-side step has succeeded (a rejected copy flush publishes nothing), and only
  when `CLUSTER_RECORD_LOCKS_ENABLED` — resolved once at connection setup into either a publisher
  or a no-op, so a node that never enables locks pays nothing per batch. The value is the frame's
  own `frameTxnLogKey`, already validated by `isValidFrameTxnLogKey` at decode; a frame whose key
  failed validation never reached the apply queue. Publication is non-throwing by construction:
  the buffer view and origin name are resolved before `onCommit` runs (the name at decode, with
  `rebuildOnMiss`, since a dropped publication costs a barrier its convergence), and a frame whose
  origin cannot be named publishes nothing rather than guessing. **Empty sequence updates publish
  nothing**: `REMOTE_SEQUENCE_UPDATE` and `SEQUENCE_ID_UPDATE` name the *sender's* cursor, which
  on a relaying stream may be another origin's key, so neither is evidence about any one origin.
  Both forms are nevertheless validated with `isValidReplicationClock` before they touch the
  received or committed cursors (round 1/2 finding): an `Infinity` or `NaN` from an authenticated
  but buggy peer holds the frame and reconnects, exactly as an invalid frame header does today.
- **Why a per-origin `applied >= position` is sound under fact 5.** The holder's locked writes
  are committed before the release entry is constructed (`#surrender` runs at `holding === 0`;
  core's §6 step-3 caveat about native settlement is core's stated weakness, not a new one), so
  every fenced write is appended before the release claims its key `P` and carries a key `< P`.
  Any entry of that origin with key `>= P` was constructed at or after `P` was claimed, hence
  appended after every fenced write. Each stream delivers an origin's log as an append-order
  prefix and the apply queue is FIFO, so once that origin's applied maximum reaches `P`, every
  fenced write is committed and visible. The release entry itself carries key `P` and is streamed
  to every capability-level peer, so the barrier converges without relying on sequence updates.
- **Clean handoff.** For each `(origin, position)`: `origin === thisNode` is satisfied by
  definition. Otherwise the origin must be a member of this database's `homeMap().homes` (core
  filters to it already; the transport refuses anything else outright), it must have advertised
  the current capability level, and this node must **subscribe to the table from some stream**:
  the receive route for the database must authorize replication from a peer (`routeEntriesIncludePeer`)
  and not exclude the table (`getExcludedTablesForRouteEntries`, which returns `null` for both
  "covered" and "no matching entry" — so it is consulted only after the authorization predicate
  says an entry matched). Any of those failing rejects at once with a 503 naming which one; core
  reports it. Otherwise the dependency is satisfied when the origin's atomic slot decodes to a
  value `>= position`. The stream that delivers the origin need not be the origin's own socket.
- **Waiting is event-driven.** Each database's transport keeps, per origin, a min-heap of
  `(threshold, waiter)`; a publication for that origin on the owner thread pops every waiter whose
  threshold it satisfies. A stream applying off the owner thread (the `droppedOffOwner` case)
  still publishes to shared memory but cannot wake in-thread waiters, so one coarse fallback
  timer per database (250 ms, armed only while waiters exist) re-checks heap heads — O(origins),
  never O(waiters). Every waiter also sits in one deadline heap bounded by `MAX_LOCK_LEASE_MS`,
  the longest deadline core can have handed the caller; it settles exactly once, with a
  `ClientError(503)` on the bound or on transport unregister/replacement, and both heaps release
  it in `finally`. Live waiter and rejection counts are exposed on `cluster_status.recordLocks`.
  Core does not pass the caller's deadline; a `deadlineMs` argument on `establishLockFreshness`
  is a one-line core addition that would remove the gap between "abandoned" and "bounded", and is
  proposed with whichever core change the open decision below lands.
- **Recovery (`null`) rejects.** `establishLockFreshness` throws a 503 naming the reason and
  increments a `recoveryRejected` counter on `cluster_status.recordLocks`. No primitive on this
  branch names a reachable member's progress in append order (fact 5), and the three that look
  like one — the local received tail, a forward scan to the highest key, a native last-appended
  key — each admit a stale read under a concrete schedule. Consequence, stated as a release
  limitation and not only here: after a home restart, a generation change, an expiry without a
  clean release, or lineage eviction, every affected key answers 503 until the barrier below
  lands. The feature stays default-off.
- **Capability level 3 -> 4, exact level recorded.** The release payload is now a versioned
  7-tuple and admission depends on a barrier a level-3 node does not run; the levels are mutually
  exclusive (`protocolCapabilities.ts:82`). The per-peer slot 29 records the peer's **exact
  advertised level** (0 for none) instead of a tri-state, so the 503 a mixed cluster answers can
  name the disagreeing peer's level. Rollout: a mixed-level cluster has no agreed home map, every
  cluster-scoped `lock()` answers 503, and the outage ends when the last node is on one level in
  either direction — no partial state, so rollback is the same operation as upgrade.
- **Deprecated LMDB selects the disabled transport.** `maxBatchTxnLogKey` is only adopted under
  `STORAGE_IS_ROCKSDB` (`replicationConnection.ts:6515`), so on LMDB nothing publishes in the
  key domain and no barrier converges — and a single-node LMDB home would otherwise receive an
  empty virgin set, skip the barrier, and lock successfully on a capability it cannot honor.
  `CLUSTER_RECORD_LOCKS_ENABLED` therefore resolves to `false` on LMDB with one error line naming
  the engine: the node advertises level 0, registers the fail-closed transport, and keeps default
  subscription placement. A `lock()` there answers the existing enablement 503.

## The open decision: the recovery barrier

Core's §7.2 recovery is "drain from every reachable member to the position each held at grant
time". Under fact 5 that position must be an **append-order** fence, and nothing on this branch
can name one. Candidates:

| Candidate | Where it lives | What it buys | What it costs |
| --- | --- | --- | --- |
| **(c) A marker write — recommended.** The probed member commits a replicated no-op `lockBarrier` control entry in the database, constructed after the probe arrived, and returns its key; the receiver drains that origin to it. Probes are coalesced per database. | core (a new control-entry type, ~the size of `lockRelease`) + harper-pro (an authenticated `record_lock_barrier` operation) | Trivially ordered after every commit the member had made before the probe — it is appended after them — and it is exactly the thing the per-origin applied slot already converges on. Terminates on an idle member. | One replicated log entry per probed member per coalesced recovery, on a path §10 already calls expensive. |
| **(a) An append ordinal.** rocksdb-js carries a per-log append ordinal through the wire and apply path, and the head is the last ordinal. | rocksdb-js + core + harper-pro | The literal §7.2 primitive with no write. | Three repositories; a wire-format change on every frame for a rare path. |
| **(b) An in-stream marker.** The probed member's outbound sender emits a marker after reading its log to end-of-file at a moment after the probe. | harper-pro + a core drain hook | No log write. | Sound only if "read to EOF" observes every entry committed before the probe; the sender consumes core's `setImmediate`-notified broadcast, so closing that window needs a synchronous drain in `transactionBroadcast`, and the marker then has to be ordered per origin on a relaying stream. |

Until one lands, recovery fails closed here.

## Approaches considered

| Axis | Candidate | Ruling |
| --- | --- | --- |
| **Different layer** | Keep the barrier in core, and expose only the raw watermark to it. | Rejected. The watermark is shared memory owned by replication, and "this node receives the table, from an authorized route, and this frame's origin is X" are replication facts, not coordinator facts. Core's own note puts the boundary here: "The transport does own the stream-specific apply-visible wait." Upheld in rounds 1 and 2. |
| **Deeper cause** | Implement recovery now against a source head derived from what exists: the local received tail (round 0), a forward scan to the highest key (round 1), or a native last-appended key (round 2). | Rejected — all three are unsound under commit-order appends or a restarted receiver; the counterexamples are in the revision history. The genuine deeper-cause fix is a new fence primitive (the open decision), not an approximation. |
| **Do less** | Reuse `RECEIVED_VERSION_POSITION` as the clean fence and skip the applied slot; or key the applied slot by peer and assume origin-pure streams. | Rejected. Received is not applied (the entry is in the decode loop's hands, not the store's). Peer-keyed progress admits on a relayed unrelated key (round 2's counterexample: A relays B; B's `Q > P` commits before A's `P`; `applied[A] >= P` passes with A's write absent). |
| **Chosen** | Per-origin, atomic, apply-time publication; event-driven bounded waiters; route/table/capability guards; recovery rejects. | Implements the half whose correctness is provable on this branch with every guard three rounds named, and refuses — rather than approximates — the half that is not. Preserves core's retry contract, keeps the feature gated off, and leaves one decision with a recommendation. |

## Testing

- Unit (`unitTests/replication/recordLockFreshness.test.mjs`): clean handoff satisfied
  synchronously; satisfied after an origin publication wakes the heap; a publication for a
  different origin wakes nothing; self-origin needs no peer; a non-member origin, a missing
  capability, an unauthorized route, and a route-excluded table each reject at once with the
  reason named; a waiter past its bound settles once with 503 and both heaps are empty; unregister
  settles every waiter; recovery (`null`) rejects and increments the counter; an empty set is a
  no-op; a torn-looking value cannot occur (the slot is one atomic word — the test stores from a
  worker thread and loads on main, the round-2 probe as a test).
- Unit (`unitTests/replication/replicationConnection` scope, where the harness allows): the
  origin slot advances from a data `end_txn` after `onCommit`'s existing work, never on a rejected
  copy flush, never from either sequence-update form, never with locks disabled; an `Infinity`
  or `NaN` in either sequence-update form holds the frame and leaves received/committed/durable
  cursors unchanged; a reset bumps the generation and a stale session's publish is ignored.
- Unit (`unitTests/replication/recordLockTransport.test.mjs`): slot positions and the grown
  buffer; exact-level recording; the disabled transport rejects `establishLockFreshness` with the
  enablement message; LMDB resolves the gate to `false`.
- Unit (`unitTests/replication/protocolCapabilities.test.mjs`): level 4 advertised, level 3 refused.
- End-to-end (`integrationTests/cluster/recordLockCluster.test.mjs`): exact convergence restored
  (`sorted(seen) === [1..N]`, every node at `N`) — probabilistic, so alongside it a deterministic
  case: hold a data apply on the successor's node (the existing one-shot commit-delay hook
  pattern), request the lock there, observe `cluster_status.recordLocks.waiters > 0` while the
  request is pending, release the hold, and assert the successor read the predecessor's value;
  a route-excluded table answering 503 immediately; a mixed-level pair answering 503 with the level
  named; a single-node LMDB `lock()` answering 503; a generation change (stage + activate a new
  generation) proving core surfaces recovery as 503 and the counter increments. A relayed
  mixed-origin case is added if the cluster fixture can express a relay topology; otherwise it is
  the unit test's guarded origin-keyed publication plus a stated gap.
