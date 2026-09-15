# Cluster record locks: the successor-freshness barrier (harper#2542's transport half, inside harper-pro#822)

Design note for the harper-pro half of `docs/record-lock-ownership.md` §7. Core owns delegation
lineage: a clean `lockRelease` carries an inherited `{originNodeName -> origin-log position}`
dependency set, the home merges the release entry's own position into it, and the next grant
returns the merged set (or `null`, a recovery marker). Core then requires the transport to make
that set true locally before the grant may admit:

```ts
establishLockFreshness(
  database: string, table: string, key: any, dependencies: LockDependencySet | null, deadlineMs: number
): Promise<LockDependencySet | void>;
```

(harper#2627, `core/resources/recordLockCoordinator.ts:301-307`; this PR's `core` submodule points
at that branch's head, and the two merge core-first per `dev/CLAUDE.md`.) The method is
**required**, so harper-pro does not compile against core until it exists.

| `dependencies` | Meaning                               | Obligation                                                                                                                      |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| an array       | exact clean-handoff lineage           | every named `(origin, position)` must be **applied and visible** locally before this call resolves; the return value is ignored |
| `null`         | recovery marker (no retained lineage) | drain from **every** home-map member to a fence each produces on request, and **return** the positions established              |

Core races the call against the lock deadline but cannot cancel it; `deadlineMs` is the remaining
wait, and every wait here is bounded by it.

## The one primitive: an exact barrier entry

harper#2625/#2627 adds the `lockBarrier` control entry. `writeLockBarrier(database, table, nonce)`
commits a replicated no-op to the table's log **after every transaction the writing node had
committed when asked** and resolves to its transaction-log position; the requester waits for that
exact entry — matched on `(origin, position, nonce)` — to commit locally. Nothing else is a fence:

- **Not a numeric watermark.** rocksdb-js appends in commit order, not key order, and a restart
  after a clock step reissues keys (`docs/transaction-log.md`), so "applied a key `>= P`" proves
  nothing: B holds 200 for A, A restarts behind, writes at 101 and releases at 102, and
  `200 >= 102` admits before either entry arrives. No receiver-side state can see A's restart.
  That disqualified every fence-word design (revision history) and is why there is no per-frame
  work on ordinary replication at all.
- **Matched as an entry, not a position.** The nonce is the identity; a reissued key with the
  wrong nonce settles nothing.
- **Delivered in append order.** A per-log range read yields entries in **file order**, filtered
  by key — probed on the pinned rocksdb-js 2.9.0 with timestamps appended as `100, 200, 101, 300`:
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

## Revision history

Six planning rounds, each `better-alternative-exists`. Rounds 1–5 were adopted in full; the
disqualifying fact for every rejected mechanism is in "Approaches considered". Round 1: the local
received tail is zero after a restart. Round 2: `Atomics` works on the native buffer (probed);
per-peer is not per-origin; polling starves the apply loop; "last appended key" is not a head.
Round 3: a global per-origin maximum admits on an excluded-table route's progress; `Atomics.store`
is not a max; the reset is not linearizable; no restart bootstrap. Round 4: `replicateByDefault`
still permits exclusions; decode drops let a frame certify a skipped transaction; the resume
cursor has no coverage provenance; self-origin after a reclone is unprovable. Round 5: the
clock-rollback counterexample ends every numeric fence; exact barriers for every unsatisfied
dependency are the mechanism. The task owner chose full soundness over documented holes
(2026-09-15), which is why harper#2628 exists.

**Round 6 — resolved by the author, not cleared.** Its headline blocker claimed replay yields a
post-rollback barrier (key 101) _before_ an earlier inherited write (key 200) because the sender
reads by key. The probe above disproves it: per-log reads are append-ordered. Its framing — an
incarnation-qualified append sequence in core's log identity, a wire/storage migration — is
therefore not required for this invariant; the residual resume skip is harper#2629. Every other
round-6 finding is adopted here: poison is **permanent** (a base copy is a `put` snapshot of
current rows and cannot re-deliver a dropped delete, so `COPY_COMPLETE` is not repair evidence);
**every** self-origin dependency is rejected once the database has ever been recloned (a
clock-ahead position from before the clone can exceed any local marker, so no numeric test is
incarnation proof), with the flag persisted **before** the clone mutates anything; a failed poison
write latches fail-closed in memory and **holds the frame** rather than advancing the cursor;
barrier requests are coalesced on the **client** only (a server that merged two callers' nonces
would answer one caller with an entry that never carries its nonce); off-owner applied barriers
are relayed with the existing `postMessage` path, not a shared-memory ring; poison persistence is
first-write-only per pair; membership, level, validation and rate checks run **before** any state
is allocated or `writeLockBarrier` is called; and the zero-cost claim gets an executable gate.

## What harper-pro has to build on

1. **Every dropped record is visible at the receive loop.** Excluded-table drops
   (`replicationConnection.ts:6292-6314`), missing-structure skips and decode errors
   (`:6455-6494`), and the LOCAL_ONLY defense drop each happen in harper-pro's own decode loop with
   the record's origin id, table and frame key in hand.
2. **A terminal apply failure inside core is not visible today.** Core's replicated apply loop logs
   and continues past a non-retryable commit failure (`Table.ts` ~1277-1288) and past any
   per-event throw (~1372-1373); the cursor then advances on the next success. harper#2628 adds
   `registerReplicatedApplyFailureListener(database, listener)`, awaited with the failed event's
   origin id and position before the next event is pulled. This PR consumes it feature-detected
   (`listenForApplyFailures`, `recordLockTransport.ts`), so it activates the moment that core
   lands; against the pinned core the hook is absent and a terminal apply failure inside core is
   **the one hole class left unrecorded** — stated in the PR as the remaining limitation, and the
   reason the feature stays default-off until harper#2628 merges.
3. **A base copy is not an authoritative replacement.** The copy walks current rows and emits
   `put` snapshots (`:5948-6045`); an absence (a dropped delete) is not transmitted. Only a fresh
   clone of the database is.
4. **A clone leaves no durable "this database was recloned" fact.** `cloneCopyComplete` is written
   at completion (`:3471`) and later removed (`:4830`); copied rows carry no local log entry.
5. **The record-lock RPC exists** (`recordLockRpc.ts`): registered operations over the existing
   replication connections, requester identity from the connection's node principal, a relay to the
   coordinating worker, and a fail-closed timeout.
6. **`decodeLockControlPayload`** (harper#2627) decodes a `lockBarrier` record's `{ nonce }`; core's
   own sink passes barriers to the coordinator, which ignores them (`Table.ts:998-1027`), so the
   transport observes applied barriers itself. Ordinary frames already pay `isLockControlType`;
   a barrier is recognised by that existing comparison and nothing is allocated or looked up for
   any other record.

## Chosen implementation

- **Clean handoff.** For each `(origin, position)` (validated with `isValidReplicationClock`;
  core checks only finite and `>= 0`):
  - `origin === thisNode`: satisfied iff the database has **never been recloned** — the local log
    is intact and the write at `position` is this node's own committed history. harper-pro persists
    an **ever-recloned** flag in the database's `dbis` store when a clone attempt _starts_ (before
    any copied row lands, so a crash mid-clone leaves the flag, never the ambiguity); with it set,
    every self-origin dependency rejects with 503 until the operator reclones the peers instead or
    the origin incarnation reaches the wire (a core follow-up, not this PR).
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
  are mutually trusted, so a collision-resistant random suffices and is documented as such) is
  registered in the database's **outstanding barrier table** before the request is sent;
  concurrent callers for the same `(database, table, origin)` whose deadlines allow share one
  request _and one nonce_; the table is bounded by `MAX_OUTSTANDING_BARRIERS` per database (excess
  rejects 503) and every entry carries its deadline.
- **Observing the entry.** In the decode loop, a record that `isLockControlType` already flags and
  whose type is `lockBarrier` has its origin id, frame key and nonce captured; at that frame's
  `end_txn` `onCommit` — after every existing step succeeded — the transport is told
  `(origin, position, nonce)` was applied. On the owner thread that settles the waiter directly;
  a stream applying on another thread posts it to the owner through the existing record-lock relay
  (`record-lock-rpc` messages, `recordLockRpc.ts`). Nonces not in the outstanding table are dropped
  at the first comparison, so barriers replicated to nodes that did not ask cost one integer lookup
  in a frame that already carried a control record, and ordinary frames cost nothing beyond the
  type comparison they pay today.
- **Poison, durable and permanent.** Any record of `(origin, table)` that a stream drops (fact 1)
  or that core reports as terminally failed (fact 2) writes a poison row
  `[Symbol.for('lockPoison'), origin, table]` to the database's `dbis` store — first write only per
  pair; later drops for a poisoned pair write nothing — **before** the drop completes: the decode
  loop awaits it, and core's failure listener awaits it. A poison write that fails latches the pair
  poisoned in memory and **holds the frame and reconnects** (the receive loop's existing
  hold-and-reconnect path), so the cursor cannot advance past an unrecorded hole; it cannot escape
  as an unhandled rejection. One warning names the record and the consequence;
  `cluster_status.recordLocks` lists poisoned pairs. A poisoned pair rejects every dependency and
  every barrier request for it, permanently: a base copy cannot repair it (fact 3), so the only
  clearance is a fresh clone of this node's database, which discards the `dbis` store with it.
- **Waiting.** Per database: the outstanding barrier table (keyed by nonce, each with origin,
  position-when-known, waiters, deadline) and one deadline heap keyed by
  `min(deadlineMs, MAX_LOCK_LEASE_MS)`. An applied barrier settles its waiters directly; a 250 ms
  fallback timer, armed only while entries exist, sweeps deadlines. Every waiter settles exactly
  once (`ClientError(503)` on deadline, cap, unregister or replacement); tombstone removal with
  compaction; every timer, listener and emitter callback is a non-throwing shell; synchronous
  `send`/`postMessage` are wrapped. Counts exposed on `cluster_status.recordLocks`: outstanding,
  applied, timeouts, rejections by reason, poisoned pairs.
- **Capability level 3 -> 4, exact level recorded**; a mixed cluster's 503 names the disagreeing
  peer's level. **LMDB resolves the feature gate to `false`** with one error line (level 0, the
  fail-closed transport, default placement). **The core hook is consumed when present**:
  `registerReplicatedApplyFailureListener` (harper#2628) is looked up at registration and, when
  absent, terminal apply failures inside core stay unrecorded — the remaining limitation named
  in the PR, closed by merging harper#2628. **Rollback runbook**: disable `replication.recordLocks` on every node and restart
  (drains admissions and stops barrier writes) _before_ downgrading; retained `lockBarrier`
  entries then replay into a level-3 node's sink as "malformed control entry" warnings —
  harmless, named here so they are not read as corruption.
- **Blob-bearing locked writes**: the barrier commits after the record; the record value is
  visible at commit while blob bytes may still be pending (`:6670-6689`), so a successor can read a
  `PENDING` blob stub exactly as any replicated reader can today. Not a freshness failure.
- **Cost, gated.** Disabled: nothing. Enabled, ordinary frames: the `isLockControlType`
  comparison the decode loop already performs; no allocation, no map lookup, no shared memory.
  Cold handoff: one RPC, one replicated no-op entry, one apply. `recordLockCost.bench.mjs` gains a
  sustained unlocked-replication throughput row and an allocation counter for disabled,
  enabled/no-barrier and barrier traffic, with the acceptance bound "no measurable change on the
  first two"; numbers go in `RECORD_LOCK_COST_DELEGATIONS.md`.

## Approaches considered

| Axis                | Candidate                                                                                                                                                                                                                                                                                   | Ruling                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Different layer** | Keep the barrier in core; expose a raw watermark.                                                                                                                                                                                                                                           | Rejected — "this stream dropped nothing for this table", "this entry committed here", and "this caller is a current member" are replication facts. Upheld in every round.                                                                      |
| **Different layer** | Fail-stop the replicated source at the first terminal apply failure (core).                                                                                                                                                                                                                 | Rejected — one poison record would wedge replication from that peer forever; the lock invariant needs the skip _observable_, not fatal. harper#2628 exposes it instead.                                                                        |
| **Deeper cause**    | An incarnation-qualified append sequence in core's log identity, carried in dependencies and barriers (round 6's framing).                                                                                                                                                                  | Not required — the premise that replay reorders a log by key is false on this checkout (probe above); the residual resume skip is harper#2629 and fails closed here. A wire/storage migration for a defect that does not exist is not adopted. |
| **Deeper cause**    | A per-origin apply-visible fence word (CAS max, generation-keyed, bootstrapped) admitting without a probe.                                                                                                                                                                                  | Rejected — a numeric key is not an append-order proof and a restart reissues keys (clock-rollback counterexample); every variant (rounds 2–5) admitted stale data under a concrete schedule.                                                   |
| **Deeper cause**    | Carry an origin incarnation in dependencies so self-origin lineage across a reclone is decidable.                                                                                                                                                                                           | Deferred — a core wire change for one edge; the ever-recloned flag gives a fail-closed answer locally.                                                                                                                                         |
| **Do less**         | Document the hole classes instead of poisoning; clear poison on `COPY_COMPLETE`.                                                                                                                                                                                                            | Rejected by the task owner (2026-09-15, option 1 over 2); and a base copy cannot re-deliver an absence (fact 3).                                                                                                                               |
| **Chosen**          | Exact same-table nonce barriers for every unsatisfied cross-origin dependency and for recovery; permanent durable per-`(origin, table)` poison from every drop and from core's failure hook; self-origin decided by the ever-recloned flag; bounded, authorized, client-coalesced requests. | Every admission rests on an entry the origin appended after the write in question and this node committed, over a stream with no recorded hole for that table; nothing rests on a key comparison, a cursor, or a timeout.                      |

## Testing

- Unit (`recordLockFreshness.test.mjs`): a dependency issues one barrier request and settles on
  the matching `(origin, position, nonce)`; right position + wrong nonce does not settle;
  concurrent callers for one `(database, table, origin)` share a request and nonce; recovery probes
  every member, returns the pairs, and rejects on any member failure; self-origin without the flag
  admits and with it rejects; non-member, wrong level, unreplicated table, poisoned pair, invalid
  position each reject with the reason; deadline settles once and leaves empty structures; 1,000
  waiters with 1 ms deadlines vanish at the deadline; the cap rejects; unregister settles
  everything; an unrelated applied barrier is dropped at the first comparison.
- Unit (`recordLockRpc.test.mjs`): the barrier operation checks principal, membership, level,
  table, nonce and rate in that order before touching state; distinct nonces never share an entry;
  answers `{ position }`.
- Unit (receive-loop scope where the harness allows): each drop kind writes the poison row before
  completing and only once per pair; core's failure listener writes it; a failed poison write holds
  the frame and does not advance any cursor; a barrier record is reported at its frame's `onCommit`
  and not before; a rejected copy flush reports nothing; the ever-recloned flag is written at clone
  start; fault injection on every listener/timer/send path with no
  `uncaughtException`/`unhandledRejection`; ordinary frames allocate nothing and touch no map.
- Unit (`recordLockTransport`, `protocolCapabilities`): exact-level slot; level 4 advertised, 3
  refused; LMDB resolves the gate to `false`; a core without the failure hook registers the
  fail-closed transport.
- End-to-end (`recordLockCluster.test.mjs`): exact convergence restored as regression coverage;
  deterministic: held apply on the successor's node → `outstanding > 0` → release → predecessor's
  value read; a **clock-rollback** case (restart the origin with a stepped clock, lower keys after
  higher) admits only after the barrier on the live path and answers 503 on a resume whose cursor
  is above the barrier's key; a route excluding the locked table → 503; a missing-structure record
  → poison survives `restartNode()` and a base copy, and only a reclone clears it; a dropped delete
  followed by a base copy → still 503; a real terminal core apply failure → poison → 503; a
  generation change → recovery probes every member and admits; a member stopped with
  `stopNodeProcess()` → 503; a same-name reclone → every self-origin dependency → 503; mixed-level
  503 naming the level; single-node LMDB 503; a blob-bearing locked write reads the record after
  the barrier.
