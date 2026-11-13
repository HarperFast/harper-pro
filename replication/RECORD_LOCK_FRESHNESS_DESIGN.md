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
  - `origin === thisNode`: satisfied iff the database is **not flagged ever-recloned** — the local
    log is intact and the write at `position` is this node's own committed history. The flag
    (`[Symbol.for('lockEverRecloned')]` in the database's `dbis` store; `markReclonedIfLockHistory`)
    is written before a clone or sharding recovery copies its first row, so a crash mid-copy leaves
    the flag, never the ambiguity — but only when this node holds an `hdb_record_lock_homes` row for
    the database that the copy did not create. A position names this node only at its own control
    entries (core's `#applyEntry` merges a release's author at the release's position; recovery
    returns barrier positions), and it appends those only under an active generation, which lives in
    that row (LOCAL_ONLY, never deleted, never cloned). So a first join, which has no row when its
    copy starts, is never flagged (harper-pro#1236). A row created during the clone attempt now in
    flight carries that attempt's id (`cloneAttempt`, set only at creation) and does not flag a copy
    of that attempt; any other row does (an install cloned over, replaced database storage, a row from
    before the field existed), and a sharding snapshot recovery (`missingShardingOriginStart`) flags
    over any row, even inside an attempt. "In flight" is `liveCloneAttempt()`, not the raw
    `HARPER_CLONE_ATTEMPT`, which outlives the attempt in every worker; the row's tag is taken the same
    way. A database storage lost in the middle of a clone attempt needs `FORCE_CLONE`: resuming the same
    attempt would trust a row it tagged on the lost storage. With the flag set, every self-origin
    dependency rejects with 503 and every later copy repeats the flush that made it durable; an upgrade
    does not clear an existing flag (it records no evidence), so the remedy is a re-clone with a fresh
    root, under a new name or a new generation (next paragraph).
    **Not decided locally:** a fully fresh root under a reused node name looks exactly like a first
    join, while a home that kept the current generation may still hold lineage naming the old
    incarnation's releases. Re-provision under a new name, or stage and activate a new generation on
    every node before that node takes cluster locks (a generation change drops every home's lineage,
    `#prepareFreshnessGeneration`). harper-pro#944 (the origin's database generation on the wire)
    decides it mechanically.
    **A lost log tail (harper-pro#1364).** An intact local log is not given after an OS crash or power
    loss: table writes run WAL-off, so the tail of `local` can be gone while peers hold it. A start on
    a new or unknown OS boot, or after a recorded log sync failure, opens an own-origin recovery epoch
    (`ownOriginRecovery.ts`); a start on the same boot keeps the previous one. A self-origin position
    minted before the epoch opened, and a recovery-marker grant (`null`), additionally wait (`ownLineage`, polled every
    `OWN_LINEAGE_POLL_MS` until the lock deadline, counted against `MAX_OUTSTANDING_BARRIERS`) until
    every required peer (cursor peers and the members this node sends to) and home has reported returning this node's writes for that epoch. The epoch's
    start is not a proven boundary, so no position before `before` is taken as intact on its own. A
    peer's report of a purge past the log's last key, or an epoch that could not be recorded, rejects
    at once (`own-lineage-unprovable`); a failed read is asked again, not recorded. An own-origin
    poison row rejects before and again after the wait. Until its own lineage is intact, the node also
    refuses to write a `lockBarrier` for a peer (503, which the requester rides through): a barrier
    written then would sit ahead of the returned writes in its log and prove nothing about them.
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
  `MAX_OUTSTANDING_BARRIERS` per database (excess rejects 503, counted before any of a call's
  waits starts) and every entry carries its deadline, which also bounds the request itself so a
  member that accepts the connection and never answers cannot pin a response waiter or a fallback
  socket past the lock.

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
- **Waiting.** Per database, every wait is in one set (origin, table, deadline, position when
  known, waiters), and each in-flight attempt is indexed by its own nonce. A waiter's deadline is
  `min(deadlineMs, MAX_LOCK_LEASE_MS)` from now on the monotonic clock. An applied barrier settles
  its waiters directly; a `BARRIER_SWEEP_MS` (250 ms) sweep, armed only while waits exist, times out
  expired waiters and deletes emptied entries. Every waiter settles exactly once (`ClientError(503)`
  on deadline, cap, unregister or replacement); every timer, listener and emitter callback is a
  non-throwing shell; synchronous `send`/`postMessage` are wrapped. `cluster_status.recordLocks`
  reports `freshness` (outstanding, applied, timeouts, retried, rejections by reason) and
  `poisoned`.
- **A failed request is asked again (core `record-locks.md` §4.5 (2)).** A rejected request — a
  socket closed under it, no connection, the origin's own refusal before its map agrees after a
  restart — is what an origin restarting looks like. The wait drops that attempt's nonce, backs off
  (250 ms doubling to 2 s, half-jittered) and asks again with a fresh nonce, re-passing every refusal
  above against the current map, until the lock's own deadline (`min(timeout, remaining lease)`) —
  the last backoff is shortened so a final attempt still gets a 250 ms step inside it, as core fits
  its last wait: at most 33 requests in a 30 s wait. Not core's 10 s `HOME_RESTART_RIDE_THROUGH_MS`:
  a process restart under load takes 10–19 s, and a failed barrier stalls the handoffs whose lineage
  names that origin (every recovery handoff names every member), where an unreachable home stalls
  every key it homes. Every attempt's request,
  the first included, is bounded by `RESTART_ATTEMPT_MS` (3 s, core's bound on a request to a home)
  or what is left of the deadline, so an origin that accepts it and never answers is asked again on a
  fresh nonce; the bound doubles after an attempt that used all of it, so a slow origin still gets
  time to answer. Once a reply names a position, its entry is waited on to the deadline. Core does not cancel a wait it abandoned (a recall past
  `RECALLED_BARRIER_GRACE_MS`, its own deadline race): such a wait keeps its slot and retries until its
  deadline. The `MAX_OUTSTANDING_BARRIERS` cap is per database, so waits on an origin down for good
  can fill it and refuse handoffs that name only live origins (`capacity`). A wait between attempts stays in the set, so the cap, the
  sweep and an unregister still see it. The proof is unchanged: only the current attempt's entry
  settles the wait, and a restarted origin's barrier follows everything its log held, so an earlier
  attempt committed with its reply lost proves nothing and harms nothing.
- **Capability level 4, exact level recorded** (slot 33). A peer at another level withholds the
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
- `integrationTests/cluster/recordLockHotKeyHandoff.test.mjs` — a barrier slower than a contender's
  poll, through `replicationLatencyInjector.mjs`, since loopback answers one inside the poll: every
  waiter resolves well inside its wait and barriers stay within twice one grant per waiter.
- `unitTests/replication/recordLockReclone.test.mjs` — when a copy sets the ever-recloned flag, and
  that the home-map row keeps its creation attempt through every write.
- `integrationTests/cluster/recordLockClonedNode.test.mjs` — a node joined through `cloneNode` hands a
  key back and forth with the leader; the same node, cloned again after losing its database storage
  with its home-map row kept, refuses its own earlier lineage (`recloned`). A second suite holds the
  clone's copy at `COPY_START` (`copyStartHoldForTest.ts`), activates the home map during the hold, and
  shows the copy that then runs leaves the node unflagged.
- Not covered by any test: the `record_lock_barrier` operation's server-side checks, the receive
  loop's poison writes, and the end-to-end refusal paths (clock rollback, an excluded route, poison
  surviving a restart or base copy, a mixed-level member, LMDB).
