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

| `dependencies` | Meaning | Obligation |
| --- | --- | --- |
| an array | exact clean-handoff lineage | every named `(origin, position)` must be **applied and visible** locally before this call resolves; the return value is ignored |
| `null` | recovery marker (no retained lineage) | drain from **every** home-map member to a fence each produces on request, and **return** the positions established |

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
- **Same table.** The barrier lands in the locked table's log, so a route that excludes the table
  excludes the barrier too and the wait ends in 503 — selective topologies fail safely without a
  coverage predicate.

A barrier proves the entry committed here. It cannot prove there is no **hole before it** — a
record of that origin and table this node dropped or failed to apply. Those are handled as poison
(below); a barrier for a poisoned `(origin, table)` is refused, never waited on.

## Revision history

Five planning rounds, each `better-alternative-exists`, each adopted; the disqualifying fact for
every rejected mechanism is in "Approaches considered". Round 1: the local received tail is zero
after a restart. Round 2: `Atomics` works on the native buffer (probed); per-peer is not
per-origin; polling starves the apply loop; "last appended key" is not a head. Round 3: a global
per-origin maximum admits on an excluded-table route's progress; `Atomics.store` is not a max; the
reset is not linearizable; no restart bootstrap. Round 4: `replicateByDefault` still permits
exclusions; decode drops let a frame certify a skipped transaction; the resume cursor has no
coverage provenance; self-origin after a reclone is unprovable. Round 5: the clock-rollback
counterexample above ends every numeric fence, and the reviewer's do-less — exact barriers for
every unsatisfied dependency and nothing else — is what this note now is. The task owner chose
full soundness over documented holes (2026-09-15), which is why harper#2628 exists.

## What harper-pro has to build on

1. **Every dropped record is visible at the receive loop.** Excluded-table drops
   (`replicationConnection.ts:6292-6314`), missing-structure skips and decode errors
   (`:6455-6494`), and the LOCAL_ONLY defense drop each happen in harper-pro's own decode loop with
   the record's origin id, table and frame key in hand.
2. **A terminal apply failure inside core is not visible today.** Core's replicated apply loop logs
   and continues past a non-retryable commit failure (`Table.ts` ~1277-1288, "source-applied
   transaction commit failed during apply") and past any per-event throw (~1372-1373); the cursor
   then advances on the next success. harper#2628 adds
   `registerReplicatedApplyFailureListener(database, listener)`, awaited with the failed event's
   origin id and position before the next event is pulled. This PR consumes it; until it merges,
   that hole class is the one stated limitation.
3. **A clone leaves no durable "this database was recloned" fact.** Clone completion persists
   `cloneCopyComplete` per source (`:3471`) and later removes it (`:4830`); copied rows carry no
   local log entry. Positions do not identify an origin incarnation, so a self-origin position from
   before a same-name reclone cannot be proven from the position alone.
4. **The record-lock RPC exists** (`recordLockRpc.ts`): registered operations over the existing
   replication connections, requester identity from the connection's node principal, a relay to the
   coordinating worker, and a fail-closed timeout.
5. **`decodeLockControlPayload`** (harper#2627) decodes a `lockBarrier` record's `{ nonce }`; core's
   own sink passes barriers to the coordinator, which ignores them (`Table.ts:998-1027`), so the
   transport observes applied barriers itself.

## Chosen implementation

- **Clean handoff.** For each `(origin, position)` (validated with `isValidReplicationClock`;
  core checks only finite and `>= 0`):
  - `origin === thisNode`: satisfied iff `position >= incarnationStart` (a key claimed at
    transport construction — anything at or after it was committed by this incarnation and is in
    the local log), or the database has never been recloned. harper-pro persists an **ever-recloned**
    flag in the database's `dbis` store at clone completion (never removed); with it set, an older
    self-origin position is unprovable and rejects with 503.
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
  `{ database, table, nonce }` → `{ position }`. Server side: the caller must be the connection's
  node principal **and** a current member of the database's home map at the exact capability level
  (a known-but-departed node cannot force replicated writes); at most one in-flight barrier write
  per `(database, table)` per caller, further requests join it (coalescing), and a per-caller rate
  bound answers 429 beyond it; the handler calls core's `writeLockBarrier` and returns its
  position. Client side: the nonce (53-bit random) is registered in the database's **outstanding
  barrier table** before the request is sent; concurrent callers for the same `(database, table,
  origin)` whose deadlines allow share one request; the table is bounded by
  `MAX_OUTSTANDING_BARRIERS` per database (excess rejects 503) and every entry carries its deadline.
- **Observing the entry.** The receive loop already decodes every record; a record with
  `auditRecord.type === 'lockBarrier'` has its origin id, frame key and nonce captured at decode,
  and at that frame's `end_txn` `onCommit` — after every existing step succeeded — the transport is
  told `(origin, position, nonce)` was applied. Nonces not in the outstanding table are ignored,
  so barriers replicated to nodes that did not ask cost nothing. This is the only per-frame work,
  and it runs only for frames that contain a barrier record.
- **Poison, durable.** Any record of `(origin, table)` that a stream drops (fact 1) or that core
  reports as terminally failed (fact 2) writes a poison row `[Symbol.for('lockPoison'), origin,
  table]` to the database's `dbis` store **before** the drop is complete (awaited in the decode
  loop / in the failure listener), one warning names the record and the consequence, and
  `cluster_status.recordLocks` lists poisoned pairs. A poisoned pair rejects every dependency and
  every barrier request until it is cleared, and it is cleared only by a **drop-free completed
  copy** of that table from that origin: a copy pass that recorded zero drops for the table ends
  with `COPY_COMPLETE`, which removes the row; a copy with any drop leaves it (a re-copy that
  re-ships the same undecodable bytes drops them again, so the row survives). Restarts keep it.
- **Waiting.** Per database: the outstanding barrier table (keyed by nonce, each with origin,
  position-when-known, waiters, deadline) and one deadline heap keyed by
  `min(deadlineMs, MAX_LOCK_LEASE_MS)`. An applied barrier on the owner thread settles its waiters
  directly; a 250 ms fallback timer, armed only while entries exist, sweeps deadlines and settles
  entries applied off the owner thread (the applied set is a small shared-memory ring per database
  so an off-owner stream can still report). Every waiter settles exactly once
  (`ClientError(503)` on deadline, cap, unregister or replacement); tombstone removal with
  compaction; every timer, listener and emitter callback is a non-throwing shell; synchronous
  `send`/`postMessage` are wrapped. Counts exposed on `cluster_status.recordLocks`: outstanding,
  applied, timeouts, rejections by reason, poisoned pairs.
- **Capability level 3 -> 4, exact level recorded**; a mixed cluster's 503 names the disagreeing
  peer's level. **LMDB resolves the feature gate to `false`** with one error line (level 0, the
  fail-closed transport, default placement). **Rollback runbook**: disable `replication.recordLocks`
  on every node and restart (drains admissions and stops barrier writes) *before* downgrading;
  retained `lockBarrier` entries then replay into a level-3 node's sink as "malformed control
  entry" warnings — harmless, but named here so they are not read as corruption.
- **Blob-bearing locked writes**: the barrier commits after the record; the record value is
  visible at commit while blob bytes may still be pending (`replicationConnection.ts:6670-6689`), so
  a successor can read a `PENDING` blob stub exactly as any replicated reader can today. Not a
  freshness failure; stated so it is not mistaken for one.
- **Cost.** Disabled: nothing. Enabled, ordinary frames: a type comparison the decode loop already
  performs. Cold handoff: one RPC, one replicated no-op entry, one apply. `recordLockCost.bench.mjs`
  runs off and on before merge with the numbers recorded in `RECORD_LOCK_COST_DELEGATIONS.md`,
  gated on no measurable change to unlocked replicated throughput.

## Approaches considered

| Axis | Candidate | Ruling |
| --- | --- | --- |
| **Different layer** | Keep the barrier in core; expose a raw watermark. | Rejected — "this stream dropped nothing for this table", "this entry committed here", and "this caller is a current member" are replication facts. Upheld in every round. |
| **Different layer** | Fail-stop the replicated source at the first terminal apply failure (core). | Rejected — one poison record would wedge replication from that peer forever; the lock invariant needs the skip *observable*, not fatal. harper#2628 exposes it instead. |
| **Deeper cause** | A per-origin apply-visible fence word (CAS max, generation-keyed, bootstrapped) admitting without a probe. | Rejected — a numeric key is not an append-order proof and a restart reissues keys (clock-rollback counterexample); every variant (rounds 2–5) admitted stale data under a concrete schedule. |
| **Deeper cause** | Carry an origin incarnation in dependencies so self-origin lineage across a reclone is decidable. | Deferred — a core wire change for one edge; the ever-recloned flag gives the same fail-closed answer locally. |
| **Do less** | Document the hole classes instead of poisoning. | Rejected by the task owner (2026-09-15, option 1 over 2). |
| **Chosen** | Exact same-table nonce barriers for every unsatisfied cross-origin dependency and for recovery; durable per-`(origin, table)` poison from every drop and from core's failure hook; self-origin decided by incarnation start or the ever-recloned flag; bounded, authorized, coalesced requests. | Every admission rests on an entry the origin appended after the write in question and this node committed, over a stream with no recorded hole for that table; nothing rests on a key comparison, a cursor, or a timeout. |

## Testing

- Unit (`recordLockFreshness.test.mjs`): a dependency issues one barrier request and settles on
  the matching `(origin, position, nonce)`; right position + wrong nonce does not settle;
  concurrent callers for one `(database, table, origin)` share a request; recovery probes every
  member, returns the pairs, and rejects on any member failure; self-origin at/after
  `incarnationStart`, older without the flag, older with the flag; non-member, wrong level,
  unreplicated table, poisoned pair, invalid position each reject with the reason; deadline settles
  once and leaves empty structures; 1,000 waiters with 1 ms deadlines vanish at the deadline; the
  cap rejects; unregister settles everything; an unrelated applied barrier is ignored.
- Unit (`recordLockRpc.test.mjs`): the barrier operation requires the node principal, current
  membership at the exact level, validates database/table/nonce, coalesces, rate-bounds, and
  answers `{ position }`.
- Unit (receive-loop scope where the harness allows): each drop kind writes the poison row before
  completing; core's failure listener writes it; a drop-free `COPY_COMPLETE` clears it and a copy
  with a drop does not; a barrier record is reported at its frame's `onCommit` and not before; a
  rejected copy flush reports nothing; the ever-recloned flag is set at clone completion; fault
  injection on every listener/timer/send path with no `uncaughtException`/`unhandledRejection`.
- Unit (`recordLockTransport`, `protocolCapabilities`): exact-level slot; level 4 advertised, 3
  refused; LMDB resolves the gate to `false`.
- End-to-end (`recordLockCluster.test.mjs`): exact convergence restored as regression coverage;
  deterministic: held apply on the successor's node → `outstanding > 0` → release → predecessor's
  value read; a **clock-rollback** case (restart the origin with `HARPER_TEST_CLOCK_OFFSET`-style
  skew, lower keys after higher) admits only after the barrier; a route excluding the locked table
  → 503; a **selective-to-full transition** (route changed, node restarted) → 503 until a full copy
  of the table completes, then admits; a missing-structure record → poison survives
  `restartNode()`, a re-copy that drops again keeps it, a clean copy clears it; a generation change
  → recovery probes every member and admits; a member stopped with `stopNodeProcess()` → 503; a
  same-name reclone → self-origin lineage from before it → 503; mixed-level 503 naming the level;
  single-node LMDB 503; a blob-bearing locked write reads the record after the barrier.
