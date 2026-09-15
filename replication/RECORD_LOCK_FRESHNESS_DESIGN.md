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
transport's promise; harper#2625 adds a `deadlineMs` argument so the transport can bound its wait
to the caller's, and until it lands the transport bounds by `MAX_LOCK_LEASE_MS` (below).

## Revision history

- **Round 1 — `better-alternative-exists`, adopted.** Evaluating the recovery marker against the
  *local inbound tail* is unsound: after a receiver restart the tail is 0 while a reachable member
  holds committed, undelivered writes. Also adopted: the unbounded-waiter leak, the disabled-path
  cost of an ungated write, an unvalidated `REMOTE_SEQUENCE_UPDATE` float, and cursors that advance
  across records the sender skips.
- **Round 2 — `better-alternative-exists`, adopted.** (i) `Atomics` **does** work on a
  `BigUint64Array` view over `getUserSharedBuffer()`'s native mapping across worker threads —
  probed live on the pinned rocksdb-js 2.9.0 — so a mirrored-`Float64` scheme is replaced by one
  atomic word; (ii) progress keyed by *peer* is not progress for the *origin* a dependency names;
  (iii) a 100 Hz waiter scan can starve the apply loop it waits on; (iv) a "last appended key" is
  not a usable target under commit-order appends. The recovery recommendation moved to a marker
  write; the task owner chose it on 2026-09-15 (core half: harper#2625).
- **Round 3 — `better-alternative-exists`, adopted.** (i) A **global** `(database, origin)` maximum
  is unsound with selective routes: a route that excludes the locked table applies a later
  transaction of the same origin and advances the fence while the covering route is stalled;
  (ii) `Atomics.store` is not a maximum — two streams publishing one origin can regress it;
  (iii) a position word and a generation word in separate slots are not linearizable against a
  reset, and the reset (`clearReplicationSharedStatus`, `subscriptionManager.ts:937`) runs right
  after the `unsubscribe-from-node` message is *posted*, not after the session drains, so a stale
  publisher can re-stamp a zeroed slot; (iv) process-local progress has no restart bootstrap, so an
  idle origin whose dependency is already durable locally leaves a clean barrier at zero forever;
  (v) the origin label on a frame is peer-supplied (`NODE_NAME_TO_ID_MAP`), so "authenticated
  origin" overstated the evidence. Round 3 named the cheaper first release this note now chooses:
  **publish fences only from direct, full-database-coverage streams**, which resolves (i), (iv)
  and (v) at once — the origin *is* the authenticated peer, the durable resume cursor for that peer
  is a valid bootstrap, and no excluded-table path can advance the fence.

## What harper-pro has to build on

1. **A received watermark already exists.** `RECEIVED_VERSION_POSITION` (slot 1 of the
   per-`(database, peer)` shared status buffer) is the highest origin transaction-log key seen from
   that peer, in the **transaction-log-key** domain since harper-pro#790 — the domain core stamps on
   a control entry (`Table.ts:5803-5846`) and hands back as `event.timestamp` on apply.
2. **It is advanced at decode time, not at apply time** (`replicationConnection.ts:6505-6511`),
   before the event reaches the apply queue. It is telemetry, and DESIGN.md's slot map says so;
   nothing here promotes it.
3. **Apply-visibility is observed only in a closure.** The per-batch `end_txn`'s `onCommit` sets
   `committedSequence` — "Commit == visibility" (`replicationConnection.ts:6666-6669`). The
   persisted resume cursor (`[seq]`) is written by core only *after* that `onCommit` resolves
   (`Table.ts` `updateRecordedSequenceId`; DESIGN.md item 18), in the same domain on RocksDB, so a
   persisted cursor value is durable evidence of applied progress from that peer.
4. **Every committed frame names an origin, but the name is peer-supplied.** A frame is one
   origin transaction keyed by that origin's log key (`frameTxnLogKey`, `:6190`); each record's
   `nodeId` resolves through the peer's `NODE_NAME_TO_ID_MAP` (`:4756-4759`) to a local id and name.
   Only when the origin **is** the delivering peer is the label backed by the connection's own
   authentication.
5. **Selective routes drop records and keep going.** A receive route that excludes a table drops
   its records inside the decode loop (`:6292-6314`) while the frame's cursor still advances; the
   sender likewise skips tables its own route excludes (`:5361`, `:5419`) and sends sequence updates
   past them. A stream therefore "applies origin O through key K" only for the tables it carries.
6. **The set of direct, full-coverage, both-sides-authorized paths is already computed.** Main's
   `computeExclusionOrigins` (DESIGN.md item 9) ANDs the peer's advertised intent with no table
   exclusions (`qualifiesForMultiHopExclusion`, `knownNodes.ts`) with the effective local receive
   decision and local `receivesFrom` coverage, per database, and ships the result to the worker on
   `subscribe-to-node` and `update-exclusion-origins`. An origin in that set is one whose own
   direct stream carries the whole database log to this node. That is exactly the predicate a
   fence needs, and it is owned by the thread that has the configuration to decide it.
7. **There is no head-read on the transaction log, and entries are appended in commit order**
   (rocksdb-js `docs/transaction-log.md`): a "highest key" is not an append-order head. The
   recovery fence therefore needs the marker entry harper#2625 adds.
8. **The shared buffer is native memory, `Atomics`-addressable, and reset non-atomically.**
   `getUserSharedBuffer` returns an `ArrayBuffer` over a native mapping shared by every thread;
   `Atomics` on a `BigUint64Array` view of it is an aligned 64-bit atomic across threads (probed).
   `clearReplicationSharedStatus` is a `Float64Array.fill(0)` (`knownNodes.ts:119-125`) issued from
   main without waiting for the worker's session to stop (`subscriptionManager.ts:918-940`).

## Chosen implementation

**Per-origin apply-visible fences, published only by the origin's own direct full-coverage
stream, in a generation-keyed atomic word; event-driven bounded waiters; recovery rejects until
harper#2625's marker lands.**

- **Which streams publish.** At connection setup (where `tableSubs`, `sequenceEntry` and the
  exclusion-origin set are already in hand, `replicationConnection.ts:7596-7640`) a session becomes
  a **fence publisher for `(database, peer)`** iff `CLUSTER_RECORD_LOCKS_ENABLED`, the peer is in the
  database's current exclusion-origin set (fact 6), and the subscription is not an explicit table
  list (`replicateByDefault` stays true). Otherwise the unchanged `onCommit` path runs — no call,
  no branch per batch. A later `update-exclusion-origins` that removes the peer retires the
  publisher (it stops publishing; it never regresses). Only frames whose origin **equals the
  peer** publish; a relayed frame on a publishing stream publishes nothing, so the fence value is
  always a key from the authenticated peer's own log, delivered over a path that carries every
  table. Trust boundary, stated: cluster members are mutually trusted to write any record; this
  design additionally refuses to let a member speak for another member's fence.
- **The fence word.** One 64-bit word per `(database, origin, fenceGeneration)` in a dedicated
  buffer `getUserSharedBuffer(['replicated', database, origin, 'lockFence', generation])`, holding
  the IEEE-754 bits of the highest applied log key from that origin, advanced by a
  `compareExchange` loop over the bit patterns (positive finite doubles order as unsigned integers,
  so "max" on the bits is "max" on the values). `generation` lives in slot 31 of the origin's
  existing status buffer as an `Atomics`-loaded integer; `clearReplicationSharedStatus` and the
  clone-attempt reset bump it (`Atomics.add`) *before* zeroing the rest, and never touch a fence
  buffer. A publisher binds its buffer at setup for the generation current then; a session the
  removal path has not yet stopped keeps writing an old buffer nobody reads. A reader loads the
  generation, resolves the buffer, and loads the word — a reader that observed generation `g+1`
  can only observe a buffer no stale publisher can reach. Buffers are process-local and small
  (one word); an old generation's buffer is dropped when its last view is released.
- **Bootstrap.** A publisher seeds its fence with the peer's persisted resume cursor
  (`sequenceEntry.seqId`, fact 3) at setup, through the same max loop. After a restart, an origin
  that stays idle still satisfies every dependency its durable cursor covers — the case round 3
  named — because a persisted `[seq]` is written only after the batch's `onCommit`.
- **Publication itself** runs at the end of the data-frame `end_txn` `onCommit`, after every
  existing step has succeeded (a rejected copy flush publishes nothing), with the frame's own
  validated `frameTxnLogKey`. It is total: the view, the scratch pair and the origin identity are
  resolved at setup inside the receive loop's error boundary, and the publish is a CAS loop over
  already-validated numbers with no allocation. Sequence updates (`REMOTE_SEQUENCE_UPDATE`,
  `SEQUENCE_ID_UPDATE`) never publish — they name a cursor, not an applied origin frame — but both
  forms are validated with `isValidReplicationClock` before touching any cursor: an `Infinity` or
  `NaN` from an authenticated but buggy peer holds the frame and reconnects, as an invalid frame
  header does today.
- **Why `fence(origin) >= position` is sound.** The holder's locked writes commit before the
  release entry is constructed (`#surrender` runs at `holding === 0`; core's §6 step-3 caveat about
  native settlement is core's stated weakness), so every fenced write is appended before the
  release claims its key `P` and carries a key `< P`; any entry of that origin with key `>= P` was
  constructed after `P` was claimed, hence appended after every fenced write. The publishing
  stream is the origin's own log delivered in append order over a path carrying every table, and
  the apply queue is FIFO, so once that stream's applied maximum reaches `P`, every fenced write
  is committed and visible. Two publishing streams for one origin (a reconnect racing its
  predecessor's drain) each deliver an append-order prefix, and the max loop cannot regress.
- **Clean handoff.** For each `(origin, position)`: the transport first validates the position
  itself (`isValidReplicationClock`; core's `normalizeDependencies` checks finite and `>= 0`, not
  the clock domain). `origin === thisNode` is satisfied by definition. Otherwise the origin must be
  in `homeMap().homes`, must have advertised the current capability level, and must be in the
  database's exclusion-origin set (fact 6) — i.e. this node receives its whole log directly. Any
  of those failing rejects at once with a 503 naming which one. Otherwise the dependency is
  satisfied when the origin's fence decodes to a value `>= position`. **Relayed and
  selectively-routed origins are not evaluable in this release** and answer 503; the general
  `(delivery path, origin)` fence that would admit them is the follow-up, not an approximation
  made here.
- **Waiting is event-driven and bounded.** Per database, per origin, a min-heap of
  `(threshold, waiter)`; a publication on the owner thread pops every satisfied waiter. A stream
  applying off the owner thread still publishes to shared memory but cannot wake in-thread
  waiters, so one 250 ms fallback timer per database, armed only while waiters exist, re-checks
  heap heads — O(origins). Every waiter also sits in one deadline heap keyed by
  `min(deadlineMs ?? MAX_LOCK_LEASE_MS, MAX_LOCK_LEASE_MS)`; it settles exactly once (a
  `ClientError(503)` on the bound or on transport unregister/replacement), removal is a tombstone
  flag with compaction when tombstones exceed half the heap, and every timer callback is wrapped.
  Live waiter, timeout and rejection counts are exposed on `cluster_status.recordLocks`.
- **Recovery (`null`) rejects** with a 503 naming the reason and increments `recoveryRejected`.
  harper#2625 adds the `lockBarrier` control entry (a replicated no-op constructed after a probe,
  whose committed position is returned); the harper-pro half — an authenticated, node-principal
  `record_lock_barrier` operation, one coalesced probe per database, and a drain of each member's
  fence to the returned position — lands in this PR once that core change is on a branch this
  worktree's `core` submodule can point at. Until then: after a home restart, a generation change,
  an expiry without a clean release, or lineage eviction, every affected key answers 503. Stated
  as a release limitation; the feature stays default-off.
- **Capability level 3 -> 4, exact level recorded.** Slot 29 records the peer's exact advertised
  level (0 for none) so a mixed cluster's 503 can name the disagreeing peer's level. Rollout: a
  mixed-level cluster has no agreed home map and every cluster-scoped `lock()` answers 503; the
  outage ends when the last node is on one level in either direction, so rollback is the same
  operation as upgrade. Operators alert on `waiters`, `timeouts`, `recoveryRejected`.
- **Deprecated LMDB resolves the feature gate to `false`** with one error line naming the engine:
  the node advertises level 0, registers the fail-closed transport, and keeps default subscription
  placement. A single-node LMDB `lock()` answers the existing enablement 503 rather than skipping
  the barrier on an empty virgin set.

## Approaches considered

| Axis | Candidate | Ruling |
| --- | --- | --- |
| **Different layer** | Keep the barrier in core, and expose only a raw watermark to it. | Rejected. "This peer's direct stream carries every table", "this frame's origin is the authenticated peer", and "this batch committed" are replication facts. Core's own note puts the boundary here. Upheld in every round. |
| **Deeper cause** | Fences per `(delivery path, origin)`, selected by actual table coverage, so relayed and selectively-routed origins become evaluable. | Deferred, not rejected: it is the general solution and the follow-up. It needs per-path coverage tracking that includes subscription-driven table selection and a per-path fence per origin; this release takes the strict subset (direct, full coverage) whose coverage predicate already exists (fact 6). |
| **Deeper cause** | Implement recovery now against a source head derived from what exists (local tail, highest key, last appended key). | Rejected — each is unsound; counterexamples in the revision history. The fence primitive is harper#2625. |
| **Do less** | Reuse `RECEIVED_VERSION_POSITION`; or a global per-origin maximum from every stream. | Rejected. Received is not applied. A global maximum admits on an excluded-table route's progress while the covering route is stalled (round 3). |
| **Chosen** | Per-origin fences published only by the origin's own direct full-coverage stream, generation-keyed and CAS-advanced, bootstrapped from the durable cursor; event-driven bounded waiters; everything else rejects. | The smallest set of streams for which the append-order-prefix argument holds, the origin label is the connection's own principal, and durable evidence exists to bootstrap. Everything outside it fails closed rather than approximately. |

## Testing

- Unit (`unitTests/replication/recordLockFreshness.test.mjs`): satisfied synchronously; satisfied
  after a publication wakes the heap; a different origin's publication wakes nothing; self-origin
  needs no peer; non-member, missing capability, and not-in-exclusion-set each reject at once with
  the reason; an invalid position rejects; a waiter past its bound settles once with 503 and both
  heaps compact to empty; rapid caller cancellation (1,000 waiters with 1 ms deadlines) leaves no
  live waiter and no timer; unregister settles every waiter; `null` rejects and counts.
- Unit, the fence word: CAS-max under the `Q`-store / delayed-`P`-store interleaving; the
  generation bump makes a stale publisher's write unreadable (deterministic check/reset/store
  interleaving); the cross-thread store/load uses rocksdb-js's real `getUserSharedBuffer`, not a
  `SharedArrayBuffer` substitute; bootstrap seeds from a persisted cursor and never regresses.
- Unit (`replicationConnection` scope, where the harness allows): a publisher is installed only
  for a peer in the exclusion-origin set with `replicateByDefault`; a relayed frame on a publishing
  stream publishes nothing; sequence updates publish nothing and both invalid forms hold the frame;
  a rejected copy flush publishes nothing; fault injection on view/mapping resolution withholds the
  fence without an `uncaughtException` or `unhandledRejection`.
- Unit (`recordLockTransport.test.mjs`, `protocolCapabilities.test.mjs`): exact-level slot; level 4
  advertised, 3 refused; disabled transport rejects with the enablement message; LMDB resolves the
  gate to `false`.
- End-to-end (`integrationTests/cluster/recordLockCluster.test.mjs`): exact convergence restored
  (`sorted(seen) === [1..N]`, every node at `N`) as regression coverage; deterministic cases: hold
  a data apply on the successor's node, request the lock there, observe `waiters > 0`, release,
  assert the predecessor's value was read; a two-route topology where a route excluding the locked
  table advances the origin past `P` while the covering route is paused — the lock must wait, and
  with the covering route removed it must answer 503; an actual process restart with an idle
  origin whose dependency is durable, proving the bootstrap admits; a mixed-level pair answering
  503 with the level named; a single-node LMDB `lock()` answering 503; a generation change proving
  recovery surfaces as 503 and `recoveryRejected` increments.
