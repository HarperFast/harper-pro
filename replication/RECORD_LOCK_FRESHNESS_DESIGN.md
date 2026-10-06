# Cluster record locks: the successor-freshness barrier (harper#2542's transport half, harper-pro#822)

The harper-pro half of core `resources/record-locks.md` §7. Core owns delegation lineage: a clean
`lockRelease` carries an inherited `{origin node name -> origin-log position}` dependency set, the
home merges the release entry's own position into it, and the next grant returns the merged set (or
`null`, a recovery marker). Core then requires the transport to make that set true locally before
the grant may admit (`ClusterLockTransport.establishLockFreshness`,
`core/resources/recordLockCoordinator.ts`):

```ts
establishLockFreshness(
  database: string, table: string, key: any, dependencies: LockDependencySet | null, deadlineMs: number
): Promise<LockDependencySet | void>;
```

| `dependencies` | Meaning                               | Obligation                                                                                                                      |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| an array       | exact clean-handoff lineage           | every named `(origin, position)` must be **applied and visible** locally before this call resolves; the return value is ignored |
| `null`         | recovery marker (no retained lineage) | drain from **every** home-map member to a fence each produces on request, and **return** the positions established              |

Core races the call against the lock deadline but cannot cancel it; `deadlineMs` is the remaining
wait, and every wait here is bounded by it.

## The one primitive: an exact barrier entry

Core's `writeLockBarrier(database, table, nonce)` (harper#2625) commits a replicated no-op
`lockBarrier` control entry to the table's log **after every transaction the writing node had
committed when asked** and resolves to its transaction-log position; the requester waits for that
exact entry — matched on `(origin, position, nonce)` — to commit locally. Nothing else is a fence:

- **Not a numeric watermark.** rocksdb-js appends in commit order, not key order, and a restart
  after a clock step reissues keys (core `resources/record-locks.md` §7.2), so "applied a key
  `>= P`" proves nothing: B holds 200 for A, A restarts behind, writes at 101 and releases at 102,
  and `200 >= 102` admits before either entry arrives. No receiver-side state can see A's restart.
  That disqualifies every fence-word design (see "Approaches considered") and is why there is no
  per-frame work on ordinary replication at all.
- **Matched as an entry, not a position.** The nonce is the identity; a reissued key with the
  wrong nonce settles nothing.
- **Delivered in append order.** A per-log range read yields entries in **file order**, filtered
  by key — probed on rocksdb-js 2.9.0 with timestamps appended as `100, 200, 101, 300`:
  `query({start: 50})` yields `100, 200, 101, 300`. A barrier appended after the fenced write is
  therefore delivered after it, on the live tail and on a resume alike. The one case a resume
  changes is an entry whose key is _below_ the subscriber's cursor (`start: 150` yields
  `200, 300`): it is never delivered, the barrier never arrives, and the wait fails closed. That
  skip is a pre-existing replication hazard on clock rollback, not a lock defect, and is filed as
  harper#2629 (a persisted clock floor in rocksdb-js closes it).
- **Same table.** The barrier lands in the locked table's log, so a route that excludes the table
  excludes the barrier too and the wait ends in 503 — selective topologies fail safely without a
  coverage predicate.

A barrier proves the entry committed here. It cannot prove there is no **hole before it** — a
record of that origin and table this node dropped or failed to apply. Those are handled as poison
(below); a barrier for a poisoned `(origin, table)` is refused, never waited on.

## What harper-pro has to build on

1. **Every dropped record is visible at the receive loop.** Excluded-table drops, undecodable
   records (`classifyReplicationDecodeError`) and the `LOCAL_ONLY` defense drop each happen in
   harper-pro's own decode loop (`replicateOverWS`) with the record's origin id, table and frame
   key in hand, and each calls `recordReplicationHole`. A record whose table decoder is missing
   holds the frame and reconnects instead of dropping.
2. **Core reports a terminal apply failure.** Its replicated apply loop (`Table.sourcedFrom`) logs
   and continues past a non-retryable commit failure and past a per-event throw, and the cursor
   then advances on the next success. `registerReplicatedApplyFailureListener(database, listener)`
   (harper#2628) is awaited with the failed event's origin id and position before the next event is
   pulled; harper-pro registers it per database (`listenForApplyFailures`, `recordLockTransport.ts`).
3. **A base copy is not an authoritative replacement.** The copy walk (`SUBSCRIPTION_REQUEST`)
   emits `put` snapshots of current rows; an absence (a dropped delete) is not transmitted. Only a
   fresh clone of the database is.
4. **Nothing else records that a database was recloned.** `cloneCopyComplete` is written when a
   copy finishes (`maybeFinishCopy`) and removed at a clone attempt's `COPY_START`; copied rows
   carry no local log entry.
5. **The record-lock RPC exists** (`recordLockRpc.ts`): registered operations over the existing
   replication connections, requester identity from the connection's node principal, a relay to the
   coordinating worker, and a fail-closed timeout.
6. **`decodeLockControlPayload`** decodes a `lockBarrier` record's `{ nonce }`; core's own sink
   (`applyLockControlEvent`) passes control entries to the coordinator, which acts only on
   `lockRelease`, so the transport observes applied barriers itself.

## Chosen implementation

- **Clean handoff.** For each `(origin, position)` (validated with `isValidLogPosition`,
  `recordLockFreshness.ts`):
  - `origin === thisNode`: satisfied iff the database has **never been recloned** — the local log
    is intact and the write at `position` is this node's own committed history. harper-pro persists
    an **ever-recloned** flag (`[Symbol.for('lockEverRecloned')]`) in the database's `dbis` store
    when a clone attempt _starts_ (before any copied row lands, so a crash mid-clone leaves the flag,
    never the ambiguity); with it set, every self-origin dependency rejects with 503 until the
    operator reclones the peers instead or the origin incarnation reaches the wire (a core
    follow-up).
  - otherwise the origin must be in `homeMap().homes` at the exact capability level, the table must
    replicate (`replicate !== false`), and `(database, origin, table)` must not be poisoned — any
    failure rejects at once with a 503 naming which. Then request a barrier from the origin
    (below) and wait for its entry. There is no fast path from memory: a dependency is either
    proven by a barrier this call observed or not proven. A delegation that passed its barrier is
    cached by core and never calls here again, so the cost is per cold handoff, not per lock.
- **Recovery (`null`).** Request a barrier from **every** `homeMap().homes` member except this
  node, wait for each entry, return `[[origin, position], ...]`; core normalizes and filters. Any
  member that cannot be probed or drained fails the recovery — the home map names every
  participant, and a participant we cannot drain is a hole, not an absence.
- **The barrier request.** A `record_lock_barrier` operation on `recordLockRpc.ts`:
  `{ database, table, nonce }` → `{ position }`. Server side, in this order and before any state
  is touched: the caller is the connection's node principal; the caller is a current member of the
  database's home map at the exact capability level; `database`/`table` exist and the table
  replicates; `nonce` is a non-negative safe integer; the per-caller rate bound (a token bucket per
  `(caller, database)`, 429 beyond it) admits the call. Then one `writeLockBarrier` per request —
  never merged across callers — and `{ position }`. Client side: the nonce (53-bit random; members
  are mutually trusted, so a collision-resistant random suffices) is registered in the database's
  **outstanding barrier table** before the request is sent; the table is bounded by
  `MAX_OUTSTANDING_BARRIERS` per database (excess rejects 503) and every entry carries its
  deadline, which also bounds the request itself so a member that accepts the connection and never
  answers cannot pin a response waiter or a fallback socket past the lock.

  **One barrier per wait, not per wave.** Concurrent callers for the same `(database, table,
origin)` sharing one request and one nonce is only sound for a caller whose dependency was known
  before the shared request left — a dependency learned afterwards may name a write the origin
  committed after it appended that barrier — so the join window is the interval before dispatch,
  and dispatch is synchronous with registration: a zero-delay window coalesces nothing, and
  widening it means delaying every cold handoff by an event-loop turn to save on bursts. The
  contract is therefore one barrier per wait, and the server's burst is sized to match it:
  `BARRIER_BURST` is exactly `MAX_OUTSTANDING_BARRIERS`, so a peer is refused only past what it can
  even have in flight, never for a legitimate wave of concurrent cold handoffs. Batching the
  pre-dispatch window is a cost optimization left open, not a correctness requirement.

- **Observing the entry.** In the decode loop, a record whose type is `lockBarrier` has its origin
  id, frame key and nonce captured; at that frame's `end_txn` `onCommit` — after every existing
  step succeeded — the transport is told `(origin, position, nonce)` was applied. On the owner
  thread that settles the waiter directly; a stream applying on another thread posts it to the
  owner via main (`record-lock-barrier-applied`, `recordLockTransport.ts`). Nonces not in the
  outstanding table are dropped at the first comparison, so barriers replicated to nodes that did
  not ask cost one lookup, and ordinary frames pay one type comparison.
- **Poison, durable and permanent.** Any record of `(origin, table)` that a stream drops (fact 1)
  or that core reports as terminally failed (fact 2) writes a poison row
  `[Symbol.for('lockPoison'), origin, table]` to the database's `dbis` store (`recordLockPoison.ts`)
  — first write only per pair; later drops for a poisoned pair write nothing — **before** the drop
  completes: the decode loop awaits it, and core's failure listener awaits it. A poison write that
  fails latches the pair poisoned in this thread's memory. On the receive loop it also **holds the
  frame and reconnects** (`recordReplicationHole`), so the cursor cannot advance past an
  unrecorded hole. Through core's failure listener it does not: core logs the listener's rejection
  and the apply loop continues (`notifyReplicatedApplyFailure`, `core/resources/replicatedApplyFailure.ts`), so that hole is visible only
  through the latch on the thread that ran the listener. A restart, or the database leaving
  replication here (`releaseRecordLockTransport`), clears the latch; an ownership handoff moves the
  barrier to a thread whose latch never had it — a known gap. One warning names the record and the consequence;
  `cluster_status.recordLocks` lists poisoned pairs. The barrier checks poison and the reclone flag
  on the cold path by reading the store, after this thread's own unwritten latch (`isPoisoned`) —
  never a per-thread cache of recorded rows — because the hole is recorded
  on the socket's thread while the barrier waits on the coordinating thread, and the drop completes
  only after the row is durable. A poisoned pair rejects every dependency and every barrier request
  for it, permanently: a base copy cannot repair it (fact 3), so the only clearance is a fresh
  clone of this node's database, which discards the `dbis` store with it.
- **Waiting.** Per database, the outstanding barrier table is a `Map` keyed by nonce (origin,
  table, position when known, waiters). A waiter's deadline is `min(deadlineMs, MAX_LOCK_LEASE_MS)`
  from now on the monotonic clock. An applied barrier settles its waiters directly; a
  `BARRIER_SWEEP_MS` (250 ms) sweep, armed only while entries exist, times out expired waiters and
  deletes emptied entries. Every waiter settles exactly once (`ClientError(503)` on deadline, cap,
  unregister or replacement); every timer, listener and emitter callback is a non-throwing shell;
  synchronous `send`/`postMessage` are wrapped. `cluster_status.recordLocks` reports `freshness`
  (outstanding, applied, timeouts, rejections by reason) and `poisoned`.
- **Capability level 4, exact level recorded** (slot 31). A peer at another level withholds the
  home map, and a freshness refusal names the required level. **LMDB resolves the feature gate to
  `false`** with one error line (`recordLockConfig.ts`: level 0, the fail-closed transport,
  default placement). **Rollback runbook**: disable `replication.recordLocks` on every node and
  restart (drains admissions and stops barrier writes) _before_ downgrading; retained `lockBarrier`
  entries then replay into a level-3 node's sink as "malformed control entry" warnings — harmless,
  named here so they are not read as corruption.
- **Blob-bearing locked writes**: the barrier commits after the record; the record value is
  visible at commit while blob bytes may still be pending (the `end_txn` `onCommit` advances the
  durable watermark without awaiting blobs), so a successor can read a `PENDING` blob stub exactly
  as any replicated reader can today. Not a freshness failure.
- **Cost.** Disabled: no barrier traffic, but the receive loop's type comparison still runs, and
  `recordReplicationHole` is not gated on the switch — every drop still pays a `dbis` read, and each
  new `(origin, table)` pair a poison row and a warning. Enabled, ordinary frames: one type
  comparison in the receive loop; no allocation, no map lookup, no shared memory. Cold handoff: one RPC, one replicated no-op entry,
  one apply. No bench measures it: `recordLockCost.bench.mjs` has no replication-throughput or
  allocation row (`RECORD_LOCK_COST_DELEGATIONS.md`, "Not measured").

## Approaches considered

| Axis                | Candidate                                                                                                                                                                                                                                                                                       | Ruling                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Different layer** | Keep the barrier in core; expose a raw watermark.                                                                                                                                                                                                                                               | Rejected — "this stream dropped nothing for this table", "this entry committed here", and "this caller is a current member" are replication facts.                                                                                               |
| **Different layer** | Fail-stop the replicated source at the first terminal apply failure (core).                                                                                                                                                                                                                     | Rejected — one poison record would wedge replication from that peer forever; the lock invariant needs the skip _observable_, not fatal. harper#2628 exposes it instead.                                                                          |
| **Deeper cause**    | An incarnation-qualified append sequence in core's log identity, carried in dependencies and barriers.                                                                                                                                                                                          | Not required — its premise, that replay reorders a log by key, is false (the append-order probe above); the residual resume skip is harper#2629 and fails closed here. A wire/storage migration for a defect that does not exist is not adopted. |
| **Deeper cause**    | A per-origin apply-visible fence word (CAS max, generation-keyed, bootstrapped) admitting without a probe.                                                                                                                                                                                      | Rejected — a numeric key is not an append-order proof and a restart reissues keys (clock-rollback counterexample); every variant admitted stale data under a concrete schedule.                                                                  |
| **Deeper cause**    | Carry an origin incarnation in dependencies so self-origin lineage across a reclone is decidable.                                                                                                                                                                                               | Deferred — a core wire change for one edge; the ever-recloned flag gives a fail-closed answer locally.                                                                                                                                           |
| **Do less**         | Document the hole classes instead of poisoning; clear poison on `COPY_COMPLETE`.                                                                                                                                                                                                                | Rejected by the task owner (2026-09-15); and a base copy cannot re-deliver an absence (fact 3).                                                                                                                                                  |
| **Chosen**          | Exact same-table nonce barriers for every unsatisfied cross-origin dependency and for recovery; permanent durable per-`(origin, table)` poison from every drop and from core's failure hook; self-origin decided by the ever-recloned flag; bounded, authorized requests, one barrier per wait. | Every admission rests on an entry the origin appended after the write in question and this node committed, over a stream with no recorded hole for that table; nothing rests on a key comparison, a cursor, or a timeout.                        |

The planning rounds that produced this table are in harper-pro#822's description.

## Testing

- `unitTests/replication/recordLockFreshness.test.mjs` — the barrier wait over injected
  dependencies: every up-front refusal, settling only on the exact `(origin, position, nonce)`,
  one request per dependency, recovery across members, the deadline sweep, the cap, close, the
  lease bound on a wait, and a hole recorded while a barrier is in flight.
- `integrationTests/cluster/recordLockCluster.test.mjs` — exact hot-key convergence across three
  nodes, with `freshness.applied >= 1` and no poisoned pairs.
- Not covered by any test: the `record_lock_barrier` operation's server-side checks, the receive
  loop's poison writes, and the end-to-end refusal paths (clock rollback, an excluded route, poison
  surviving a restart or base copy, a reclone, a mixed-level member, LMDB).
