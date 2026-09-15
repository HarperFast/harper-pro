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
transport's leak, so every wait here must have its own bound and its own teardown.

**Revision history — round 1, `better-alternative-exists`, adopted.** The first cut evaluated the
recovery marker against the position the *local inbound stream* held at grant time. The planning
reviewer's counterexample holds: after a receiver restart `received[A] === applied[A] === 0`
before any frame arrives, so a recovery barrier measured against the local tail passes at once
while a reachable A holds committed writes it has not yet delivered. The reviewer also found the
unbounded-waiter leak above, the disabled-path cost of an ungated watermark write, a
`REMOTE_SEQUENCE_UPDATE` float that reaches `Math.max` unvalidated, and the fact that a
per-database cursor advances across records the sender skips for a table this peer does not
receive. All adopted below. Its prescription of `BigInt64Array` + `Atomics` for the watermark is
**not** adoptable on the facts: `getUserSharedBuffer` returns a plain `ArrayBuffer` over native
shared memory, not a `SharedArrayBuffer`, so `Atomics` cannot address it, and transaction-log keys
are fractional floats (`1789480100774.2732` from a live `getTimestamp()`), so an integer slot has no
lossless encoding. The tear-freedom requirement is met differently (below). Its "genuine do-less"
— clean barriers now, `null` recovery rejects with 503 until a trustworthy source-head primitive
exists — is what this note now chooses, and the recovery barrier's shape is the one open decision.

## What harper-pro has to build on

1. **A received watermark already exists.** `RECEIVED_VERSION_POSITION` (slot 1 of the
   per-`(database, peer)` shared status buffer) is the highest origin transaction-log key seen from
   that peer. Since harper-pro#790 it is in the **transaction-log-key** domain — the same domain
   core stamps on a control entry (`Table.ts:5803-5846`, `position = txnTime`) and hands back as
   `event.timestamp` on apply — so a dependency position and this watermark are directly comparable.
2. **It is advanced at decode time, not at apply time.** `replicationConnection.ts:6505-6511` sets
   it inside the decode loop, before the event reaches the apply queue. It answers "received",
   which is strictly weaker than the "applied and visible" core asks for.
3. **Apply-visibility is observed, but only in a closure.** The per-batch `end_txn`'s `onCommit`
   sets `committedSequence` with the comment "Commit == visibility"
   (`replicationConnection.ts:6666-6669`). Nothing publishes it outside the connection.
4. **There is no head-read on the transaction log.** `RocksTransactionLogStore.getKeys()` is a
   `return []` stub, so `lastTimeInAuditStore()` yields `undefined` on the v5 engine and there is no
   reverse scan at all.
5. **Log entries are appended in commit order, not timestamp order** (rocksdb-js
   `docs/transaction-log.md` §"Reading The Transaction Log"): a transaction claims its key from the
   process-wide monotonic clock at construction and is appended at commit, so a later-constructed
   entry can precede an earlier-constructed one in the file, and therefore on the wire. A "highest
   key seen" is not a head in append order. This rules out a forward-scan source head as well as
   the local-tail snapshot.
6. **A peer's slot is that peer's stream, in whatever origin domains it carries.** A relayed frame
   carries the *origin's* log key (DESIGN.md item 18), so slot `[A]` is a maximum over every origin
   A forwards. In the full mesh the multi-hop exclusion (DESIGN.md item 9) keeps a direct
   subscription to A's own writes only; the barrier depends on that.
7. **The shared buffer is a plain `ArrayBuffer`, single writer per `(database, peer)`.**
   `NodeReplicationConnection` retires a superseded session before installing a socket (DESIGN.md
   item 15), so exactly one apply loop writes a given peer's slots at a time. A 64-bit aligned
   store is a single instruction on every platform Harper ships on, but the language gives no
   tear-freedom guarantee for a plain buffer, and `Atomics` is unavailable on it (above).

## Chosen implementation

**Publish the apply-visible watermark; evaluate clean lineage against it; fail recovery closed.**

- **`APPLIED_VERSION_POSITION` (slot 31) and its mirror (slot 32).** Advanced only from the
  apply loop's `end_txn` `onCommit`, after every existing commit-side step has succeeded — a copy
  flush that rejects leaves the watermark untouched — to the received position the batch carried,
  and only when `CLUSTER_RECORD_LOCKS_ENABLED`, so a node that never enables locks pays nothing.
  Both the data-frame `end_txn` and every `seqUpdateEndTxn` advance it (composed, not overwritten),
  because the empty `REMOTE_SEQUENCE_UPDATE` batches are what let `received` stay ahead of
  `applied` across an idle period. The value is validated with the same `isValidReplicationClock`
  predicate the frame header gets, and the slot is written twice — the mirror second. A reader
  accepts the value only when both slots agree; a torn read is indistinguishable from "not yet
  reached" and costs one poll interval, never an early admission. Every existing reset of the
  received watermark (the clone-attempt zeroing, `clearReplicationSharedStatus`) zeroes both.
  `REPLICATION_SHARED_STATUS_SLOTS` grows from 32 to 40; the buffer is process-local shared memory
  resolved through one accessor, which the slot map already documents as safe to grow.
- **Clean handoff.** For each `(origin, position)`: `origin === thisNode` is satisfied by definition
  — a position in our own log is our own committed write. Otherwise the peer must be one this node
  **receives the table from**: a buffer must already exist for `(database, origin)` (never created
  on demand for this check — `statusFor` creates one, so the check reads the accessor's registry
  instead), the peer must have advertised the capability level, and the table must not be excluded
  by this node's receive route for the peer (`getExcludedTablesForRouteEntries`, the same predicate
  the subscription uses). Any of those failing rejects at once, and core answers 503. Otherwise the
  dependency is satisfied when `applied[origin] >= position`.
- **Why `applied >= position` is sound under fact 5.** The holder's locked writes are committed
  before the release entry is constructed (`#surrender` runs at `holding === 0`; core's §6 step-3
  caveat about native settlement is core's stated weakness, not a new one), so every one of them is
  appended before the release claims its key `P`. Any entry with key `> P` was constructed after `P`
  was claimed, hence appended after every write `P` fences. The apply queue is FIFO per connection,
  so once the applied maximum reaches `P`, every entry appended before the release — the whole
  fenced set — is committed and visible. The release entry itself may still be in flight; it is
  not data.
- **Waiting.** Check synchronously first; a clean handoff whose predecessor released through the
  same stream is usually already satisfied and schedules nothing. Otherwise one 10 ms timer per
  database drives every waiter on it. Each waiter is bounded by `MAX_LOCK_LEASE_MS` — the longest
  deadline core can have handed the caller — and is torn down when the database's transport is
  unregistered or replaced, so an abandoned wait cannot outlive the lock that asked for it, and
  the count of live waiters is exposed on `cluster_status.recordLocks` for the leak test to read.
- **Recovery (`null`) rejects.** `establishLockFreshness` throws a 503 naming the reason. This is
  deliberate scope, not an omission: no primitive on this branch can name a reachable member's
  head in *append* order, and the two that look like one (the local received tail, a forward scan
  to the highest key) both admit a stale read under a concrete schedule. The consequence is stated
  plainly: after a home restart, a generation change, an expiry without a clean release, or
  lineage eviction, every affected key answers 503 until the barrier below lands. The feature
  stays gated off, exactly as before this change.
- **Capability level 3 -> 4.** The release payload is now a versioned 7-tuple and admission now
  depends on a barrier a level-3 node does not run. The levels are mutually exclusive already
  (`protocolCapabilities.ts:82`), so bumping the constant keeps a level-3 peer out of the ring
  rather than silently admitting without a fence. Rollout: a mixed-level cluster has no agreed home
  map, every cluster-scoped `lock()` answers 503 naming the disagreeing peer's level, and the
  outage ends when the last node is on the same level in either direction — there is no partial
  state, so rollback is the same operation as upgrade.
- **Deprecated LMDB advertises level 0.** `maxBatchTxnLogKey` is only adopted under
  `STORAGE_IS_ROCKSDB` (`replicationConnection.ts:6515`), so on LMDB the applied watermark and the
  received watermark are in different domains and no barrier converges. Rather than advertise a
  capability every barrier then times out on, `replication.recordLocks: true` on LMDB logs one
  error naming the engine and the node advertises `recordLocks: 0`, which fails cluster locks
  closed with the existing enablement message.

## The open decision: the recovery barrier

Core's §7.2 recovery is "drain from every reachable member to the position each held at grant
time". On this branch nothing can name that position in append order (facts 4 and 5). Three
candidates, each a real change and none improvised here:

| Candidate | Where it lives | What it buys | What it costs |
| --- | --- | --- | --- |
| **(a) A native append-order head.** rocksdb-js exposes the last *appended* entry's key per log (it already tracks `_getLastCommittedPosition` as a byte offset); core's `RocksTransactionLogStore` surfaces it; harper-pro adds an authenticated `record_lock_head` operation and drains to the answer. | rocksdb-js + core + harper-pro | The barrier §7.2 literally describes: every write a reachable member had committed at probe time. Cheap per probe. | Three repositories in sequence; the head must be defined as "no earlier-appended entry has a larger key" to be a valid target under fact 5, which is a rocksdb-js invariant to state and test. |
| **(b) An in-stream marker.** The probed member's outbound sender, on request, emits a marker frame after it has read its log to end-of-file *at a moment after the probe*; the receiver pushes it through the apply queue and treats its commit as the barrier. | harper-pro (+ a small core hook) | No new head primitive; terminates on an idle peer; ordered by construction. | Correct only if "read to EOF" observes every entry committed before the probe. The sender consumes core's broadcast queue, which is notified from `setImmediate`, so a commit can be durable and not yet notified; closing that window needs a synchronous drain hook in core's `transactionBroadcast`. |
| **(c) A marker write.** The probed member commits a replicated no-op entry in the database and returns its key. | core (a `lockBarrier` control type) + harper-pro | Trivially ordered after every prior commit; terminates. | One replicated log entry per probed member per recovery, on a path §10 already calls expensive; needs a new control-entry type in core. |

**Recommendation: (a).** It is the only candidate whose guarantee is exactly the one §7.2
states, it is the cheapest per recovery, and the rocksdb-js half is small. Until it lands,
recovery fails closed here. (b) is the fallback if the rocksdb-js change is unwelcome; (c) is
listed for completeness and not recommended.

## Approaches considered

| Axis | Candidate | Ruling |
| --- | --- | --- |
| **Different layer** | Keep the barrier in core, and expose only the raw watermark to it. | Rejected. The watermark is per-`(database, peer)` shared memory owned by replication, and "receives the table from this peer" is a replication fact (a subscription exists, is applying, and is not route-excluded), not a coordinator fact. Core's own note puts the boundary here for the same reason: "The transport does own the stream-specific apply-visible wait." Round 1 upheld this ruling. |
| **Deeper cause** | Implement the recovery barrier now against a source head derived from what exists: the local received tail (round 0), or a forward scan to the highest key on the member (the first response to round 1). | Rejected — both are unsound. The local tail is zero after a receiver restart while a reachable member holds undelivered commits (round 1's blocker). The highest key is not an append-order head (fact 5): with `T1` claimed at 100 and `T2` at 101, `T2` can commit first, a probe answers 101, and the receiver's maximum reaches 101 before `T1` — committed before the probe — is applied. The genuine deeper-cause fix is candidate (a), which needs a rocksdb-js primitive and is the open decision, not something to approximate here. |
| **Do less** | Reuse `RECEIVED_VERSION_POSITION` as the clean fence and skip the applied slot. | Rejected. Received is not applied: the entry is in the decode loop's hands, not the store's, so a successor can pass the barrier and then read the predecessor's pre-write value — the exact hazard §7.1 exists to close. |
| **Chosen** | Publish an apply-visible watermark per `(database, peer)`; evaluate clean lineage against it with the table-completeness, capability and bounded-wait guards; reject recovery markers with 503 until the append-order head exists. | Implements the half whose correctness is provable on this branch, with every guard round 1 named, and refuses — rather than approximates — the half that is not. It preserves core's retry contract, keeps the feature gated off, and leaves one decision, stated with its options and a recommendation. |

## Testing

- Unit (`unitTests/replication/recordLockFreshness.test.mjs`): clean handoff satisfied
  synchronously; satisfied after the applied slot advances; a torn (mirror-disagreeing) read
  waits rather than admits; self-origin needs no peer; an origin with no buffer, no capability, or
  a route-excluded table rejects at once; a wait past its bound rejects and leaves no waiter; an
  unregister tears every waiter down; recovery (`null`) rejects with 503; an empty set is a no-op.
- Unit (`unitTests/replication/replicationConnection` scope, where the harness allows): the
  applied slot advances from a data `end_txn` and from an empty sequence update, only after
  `onCommit`'s existing work, never on a rejected copy flush, and not at all with locks disabled.
- Unit (`unitTests/replication/recordLockTransport.test.mjs`): slot positions and the grown
  buffer; the disabled transport rejects `establishLockFreshness` with the enablement message; the
  LMDB refusal advertises level 0.
- Unit (`unitTests/replication/protocolCapabilities.test.mjs`): level 4 advertised, level 3 refused.
- End-to-end (`integrationTests/cluster/recordLockCluster.test.mjs`): the concurrent-increment
  assertion goes back to **exact** convergence — `sorted(seen) === [1..N]` and every node
  converging to `N`, not merely to one another. It was weakened in this PR's round 4/5 precisely
  because a handoff carried exclusion but not freshness; that is what this change restores.
  Deterministic coverage the reviewer asked for and this note commits to where the harness
  permits: a held apply (`HARPER_TEST_COPY_COMMIT_DELAY_ONCE_DB`-style hook) proving a clean
  handoff waits and the successor then reads the predecessor's value; a route-excluded table
  answering 503 immediately; a mixed-level pair answering 503 with the level named. Recovery
  cases stay `test.skip` naming this note's open decision, as the crash-recovery test already
  does for harper#2498.
