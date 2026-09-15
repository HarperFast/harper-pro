# Cluster record locks: the successor-freshness barrier (harper#2542's transport half, inside harper-pro#822)

Design note for the harper-pro half of `docs/record-lock-ownership.md` §7, now that harper#2613
has merged and harper#2625 (PR harper#2627, `feat/record-lock-barrier-entry`) supplies the
recovery fence. Core owns delegation lineage: a clean `lockRelease` carries an inherited
`{originNodeName -> origin-log position}` dependency set, the home merges the release entry's own
position into it, and the next grant returns the merged set (or `null`, a recovery marker). Core
then requires the transport to make that set true locally before the grant may admit:

```ts
establishLockFreshness(
  database: string, table: string, key: any, dependencies: LockDependencySet | null, deadlineMs: number
): Promise<LockDependencySet | void>;
```

(`core/resources/recordLockCoordinator.ts:301-307` on harper#2627.) It is **required**, so
harper-pro no longer compiles against core until it exists. This PR's `core` submodule points at
harper#2627's head; the two merge together, core first (the coordinated-PR flow in
`dev/CLAUDE.md`).

Two modes, and one fence primitive:

| `dependencies` | Meaning | Obligation |
| --- | --- | --- |
| an array | exact clean-handoff lineage | every named `(origin, position)` must be **applied and visible** locally before this call resolves; the return value is ignored |
| `null` | recovery marker (no retained lineage) | drain from **every** home-map member to a fence each produces on request, and **return** the positions established, so the delegation carries them onward |

The fence is core's `lockBarrier` control entry: `writeLockBarrier(database, table, nonce)` commits
a replicated no-op **after every transaction the writing node had committed when asked** and
resolves to its transaction-log position; the requester matches the applied entry on
`(origin, position, nonce)` — the nonce because a restart after a clock step can reissue a log key
(harper#2627, `recordLockCoordinator.ts:2045-2070`). Core races this call against the lock deadline
but cannot cancel it; `deadlineMs` is the remaining wait, so the transport bounds its own work to it.

## Revision history

- **Round 1 — adopted.** Evaluating recovery against the *local inbound tail* is unsound (zero
  after a restart while a reachable member holds undelivered commits). Also: the abandoned-waiter
  leak, ungated hot-path cost, an unvalidated sequence-update float, cursors advancing across skips.
- **Round 2 — adopted.** `Atomics` **does** work on a `BigUint64Array` view over
  `getUserSharedBuffer()`'s native mapping across threads (probed on rocksdb-js 2.9.0); per-peer
  progress is not per-origin progress; a 100 Hz waiter scan starves the apply loop; a "last appended
  key" is not an append-order head. The recovery fence moved to a marker write — chosen by the task
  owner on 2026-09-15, implemented as harper#2625/#2627.
- **Round 3 — adopted.** A global per-origin maximum is unsound with selective routes;
  `Atomics.store` is not a max; a separate generation word is not linearizable against the reset
  (which runs after the unsubscribe is *posted*, `subscriptionManager.ts:918-940`); process-local
  progress has no restart bootstrap; the frame's origin label is peer-supplied. Chosen: publish only
  from direct, full-coverage streams.
- **Round 4 — adopted.** `replicateByDefault` still permits exclusions (`replicate: false` tables,
  `receivesFrom` excludes; `replicationConnection.ts:7618-7626`), and decode failures skip a record
  while the frame continues (`:6455-6494`), so end-of-frame publication could certify a skipped
  transaction; the persisted resume cursor advances across sender skips and decode drops, so it has
  no full-coverage provenance and **cannot bootstrap a fence**; a self-origin dependency is not
  provable after a reclone under the same name; without core's deadline argument the five-minute
  waiter bound is a resource path. This round: the publisher requires a **zero-exclusion** stream
  and **poisons itself on any dropped record**; there is **no cursor bootstrap** — a clean
  dependency whose fence is behind asks the origin for a barrier instead; a self-origin position
  older than this node's clone baseline fails closed; `deadlineMs` is real (harper#2627) and live
  waiters are capped.

## What harper-pro has to build on

1. **Received is not applied.** `RECEIVED_VERSION_POSITION` (slot 1, per `(database, peer)`) is the
   highest log key *decoded* from that peer (`replicationConnection.ts:6505-6511`), in the
   transaction-log-key domain since harper-pro#790. Telemetry; nothing here promotes it.
2. **Apply-visibility is observed only in a closure.** The per-batch `end_txn`'s `onCommit` —
   "Commit == visibility" (`:6666-6669`). The persisted `[seq]` cursor is written after it, but
   records "processed through", not "every record applied" (sender skips `:5536-5550`, receiver
   persists `:4862-4879`, decode drops `:6455-6494`), so it is not fence evidence.
3. **Every committed frame names an origin, and the name is peer-supplied.** A frame is one origin
   transaction keyed by that origin's log key (`frameTxnLogKey`, `:6190`); each record's `nodeId`
   resolves through the peer's `NODE_NAME_TO_ID_MAP` (`:4756-4759`). Only when the origin **is** the
   delivering peer is the label backed by the connection's own principal. Cluster members are
   mutually trusted to write any record; this design only refuses to let a member speak for another
   member's fence. Byzantine members are out of scope.
4. **Streams drop records and keep going.** Excluded tables are dropped in the decode loop
   (`:6292-6314`); a record whose shared structure is missing, or that fails to decode, is skipped
   with a metric and the frame commits without it (`:6455-6494`); the sender skips tables its own
   route excludes (`:5361`, `:5419`) and sends sequence updates past them. "Applied origin O through
   key K" is true only of the records the stream actually committed.
5. **The set of direct, both-sides-authorized, route-complete paths is already computed.** Main's
   `computeExclusionOrigins` (`subscriptionManager.ts:611-629`; DESIGN.md item 9) ANDs the peer's
   advertised intent with no table exclusions (`qualifiesForMultiHopExclusion`) with the effective
   local receive decision and local `receivesFrom` coverage, and ships the result to the worker on
   `subscribe-to-node` / `update-exclusion-origins` (`replicator.ts:767-773`, emitted synchronously
   from a `.then()` — a listener must not throw). It does **not** check table-level
   `replicate: false`; the connection's own setup does (`tableSubs`, `:7618-7626`).
6. **Control entries are visible on the receive path.** A `lockBarrier` entry is an ordinary audit
   record with `auditRecord.type === 'lockBarrier'` whose payload `decodeLockControlPayload` decodes
   to `{ nonce }`; core's own sink hands it to the coordinator, which ignores it (harper#2627,
   `Table.ts:998-1027`). The transport observes applied barriers at its own receive loop.
7. **There is no head-read on the transaction log, and entries are appended in commit order**
   (rocksdb-js `docs/transaction-log.md`), which is why the fence is a committed entry and not a key.
8. **The shared buffer is native memory, `Atomics`-addressable, and reset non-atomically**
   (`clearReplicationSharedStatus`, `knownNodes.ts:119-125`, from main without draining the worker).
9. **A clone leaves a baseline.** Clone completion persists `{ cloneAttempt, copyStartTime }` under
   `cloneCopyComplete` (`replicationConnection.ts:3471`); copied rows carry no local log entry, so a
   position claimed before `copyStartTime` names history this incarnation may not hold.

## Chosen implementation

**Per-origin apply-visible fences published only by the origin's own zero-exclusion direct
stream, poisoned on any drop; a barrier probe whenever memory evidence is insufficient; bounded,
event-driven waiters; everything else fails closed.**

- **Which sessions publish.** At connection setup (`:7596-7640`), a session becomes the **fence
  publisher for `(database, peer)`** iff `CLUSTER_RECORD_LOCKS_ENABLED`, the peer is in the
  database's current exclusion-origin set (fact 5), `replicateByDefault` is true **and
  `tableSubs` is empty** (no `replicate: false` table, no route exclusion — fact 4). Otherwise the
  unchanged `onCommit` path runs: no view, no listener, no call, no per-frame branch. The
  `exclusion-origins-updated` listener retires a publisher whose peer left the set (it stops; it
  never regresses) and is wrapped so it cannot throw into the emitter. Only frames whose origin
  **equals the peer** publish.
- **Poison.** Any record a publishing session does not commit — an excluded-table drop, a
  missing-structure skip, a decode error, the LOCAL_ONLY defense drop — marks the publisher
  **poisoned** for `(database, origin)`: it publishes nothing further, one warning names the record
  and the consequence, and `cluster_status.recordLocks` reports it. A reconnect resumes past the
  dropped record, so the gap survives sessions; poison clears only when a full copy from that
  peer completes (`COPY_COMPLETE`), which re-delivers the table. While poisoned, a dependency on
  that origin **rejects** — a barrier probe cannot help, because the dropped record is missing
  regardless of any later progress on the stream. Fail closed is the only honest answer to a hole
  in the stream.
- **The fence word.** One 64-bit word per `(database, origin, fenceGeneration)` in a dedicated
  buffer `getUserSharedBuffer(['replicated', database, origin, 'lockFence', generation])`, holding
  the IEEE-754 bits of the highest applied log key from that origin, advanced by a
  `compareExchange` loop over the bit patterns (positive finite doubles order as unsigned
  integers). `generation` is an `Atomics` integer in slot 31 of the origin's status buffer, bumped
  by `clearReplicationSharedStatus` and the clone-attempt reset *before* they zero anything and
  never touching a fence buffer; a publisher binds its buffer at setup for the generation current
  then, so a session the removal path has not yet stopped writes a buffer no reader resolves. A
  reader loads the generation, resolves the buffer, loads the word. Reader/reset and writer/reset
  interleavings are both tested. **No bootstrap**: a new generation starts at zero.
- **Publication** runs at the end of the data-frame `end_txn` `onCommit`, after every existing
  step succeeded (a rejected copy flush publishes nothing), with the frame's validated
  `frameTxnLogKey`; total by construction — views and identity resolved at setup inside the receive
  loop's boundary, the publish a CAS loop over validated numbers, no allocation. A frame carrying a
  `lockBarrier` record additionally records `(origin, position, nonce)` as **applied** in the
  database's in-memory barrier table (owner thread) and wakes its waiter. Sequence updates never
  publish; both forms are validated with `isValidReplicationClock` before touching any cursor.
- **Why `fence(origin) >= position` is sound.** The holder's locked writes commit before the release
  claims its key `P`, so every fenced write is appended before it with a key `< P`; any entry of
  that origin with key `>= P` was constructed after `P` was claimed, hence appended after every
  fenced write. A publishing stream is the origin's own log in append order over a path carrying
  every table with nothing dropped (or it is poisoned), the apply queue is FIFO, so once its applied
  maximum reaches `P` every fenced write is committed and visible. Two publishing streams for one
  origin each deliver an append-order prefix and the CAS max cannot regress.
- **Clean handoff.** Validate each position (`isValidReplicationClock`; core checks finite and
  `>= 0` only). `origin === thisNode`: satisfied iff `position >= cloneBaseline` (fact 9; older
  positions name history this incarnation may not hold → 503). Otherwise the origin must be in
  `homeMap().homes`, at the current capability level, in the exclusion-origin set, not poisoned,
  and the table must replicate (`replicate !== false`) — any failure rejects at once with a 503
  naming which. Then: if `fence(origin) >= position` return; else **probe** — the same coalesced
  barrier request recovery uses, for that origin only — and wait for the barrier entry to apply.
  Nothing waits on organic traffic: an idle origin after a restart costs one probe, never a
  timeout. This is what replaces the bootstrap, and it is sound because the barrier is appended
  after the write at `position`.
- **Recovery (`null`).** One coalesced probe per database at a time: every `homeMap().homes`
  member except this node is asked, over the existing record-lock RPC (`recordLockRpc.ts`, node
  principal, 403 otherwise) for a `record_lock_barrier` on `(database, table)` with a fresh nonce;
  the member calls core's `writeLockBarrier` and answers `{ position }`. The requester waits until
  each member's barrier entry is observed applied — matched on `(origin, position, nonce)`, not on
  the fence — and returns `[[origin, position], ...]`; core normalizes and filters to `homes`. A
  member that cannot be probed (no publishing stream to it, RPC failure, poisoned, barrier write
  rejected) fails the recovery: §7.2's "unreachable member" weakness is not claimed here, because
  the home map names every participant and a participant we cannot drain is a hole, not an
  absence. Callers arriving during an in-flight probe join it if their `deadlineMs` allows,
  otherwise start the next one after it settles (a join only reuses a probe whose barriers were
  requested after the joiner asked).
- **Waiting.** Per database: per-origin threshold heaps for fence waits, a barrier table keyed
  `(origin, position, nonce)` for probe waits, one deadline heap keyed by
  `min(deadlineMs, MAX_LOCK_LEASE_MS)`. A publication or an applied barrier on the owner thread
  settles waiters directly; a 250 ms fallback timer, armed only while waiters exist, re-checks heap
  heads for streams applying off the owner thread. Every waiter settles exactly once
  (`ClientError(503)` on deadline, cap, unregister or replacement); removal is a tombstone with
  compaction past half the heap; every timer and listener callback is wrapped. **Cap**: at most
  `MAX_FRESHNESS_WAITERS` (10,000) live waiters per database; beyond it a new call rejects with
  503 rather than queue. `cluster_status.recordLocks` exposes waiters, timeouts, rejections by
  reason, probes, and poisoned origins.
- **Capability level 3 -> 4, exact level recorded**; a mixed cluster's 503 names the disagreeing
  peer's level; rollback is the same operation as upgrade. **LMDB resolves the feature gate to
  `false`** with one error line: level 0, the fail-closed transport, default placement. **Activation
  needs no migration**: fences are built only from frames a publishing session committed, never
  from cursors.
- **Disabled cost is zero by construction** (no publisher installed); enabled cost is one origin
  comparison and one CAS per committed frame on publishing sessions. `recordLockCost.bench.mjs`
  runs off and on before merge and the numbers go in `RECORD_LOCK_COST_DELEGATIONS.md`.

## Approaches considered

| Axis | Candidate | Ruling |
| --- | --- | --- |
| **Different layer** | Keep the barrier in core; expose a raw watermark. | Rejected — "this stream carries every table and dropped nothing", "this frame's origin is the connection's principal", "this batch committed" are replication facts. Upheld in every round. |
| **Deeper cause** | Fences per `(delivery path, origin)` by actual table coverage, admitting relayed and selectively-routed origins. | Deferred: the general solution, needing per-path coverage and drop tracking; this release takes the subset (direct, zero-exclusion) whose predicate exists. A relayed or selective origin still gets a correct answer — a barrier probe or 503 — never an approximate one. |
| **Deeper cause** | Bootstrap fences from durable evidence with a coverage epoch. | Rejected for this release — no existing durable value has full-coverage provenance (fact 2), and inventing one is a storage change; the barrier probe answers the same need without it. |
| **Do less** | Received watermark; global per-origin max from every stream; a per-peer max; cursor bootstrap. | Rejected — each admits stale data under a concrete schedule (revision history). |
| **Chosen** | Zero-exclusion direct-stream fences, poisoned on drop, generation-keyed and CAS-advanced; barrier probes for recovery *and* for a clean dependency the fence has not reached; capped, deadline-bounded waiters; everything else rejects. | Every admission rests on a committed entry the origin appended after the write in question, delivered over a stream proven to have dropped nothing; nothing rests on a cursor, a heuristic, or a timeout. |

## Testing

- Unit (`recordLockFreshness.test.mjs`): satisfied synchronously; satisfied by a publication; a
  different origin wakes nothing; self-origin below/above the clone baseline; non-member, wrong
  level, not-in-set, poisoned, unreplicated table, invalid position each reject with the reason; a
  clean dependency behind the fence issues exactly one probe and settles on the matching barrier;
  a barrier with the right position and wrong nonce does not settle; recovery probes every member,
  coalesces concurrent callers by request time, returns the pairs, and rejects on any member
  failure; deadline settles once and leaves empty heaps; 1,000 waiters with 1 ms deadlines vanish
  at the deadline; the cap rejects the 10,001st; unregister settles everything.
- Unit, the fence word: CAS-max under `Q`-then-`P`; generation bump vs stale writer and vs a
  concurrent reader; the cross-thread test uses rocksdb-js's real `getUserSharedBuffer`.
- Unit (`replicationConnection` scope where the harness allows): publisher installed only for a
  peer in the set with `replicateByDefault && tableSubs.length === 0`; a `replicate: false` table
  prevents installation; a relayed frame publishes nothing; each drop kind poisons and a copy
  completion clears; sequence updates publish nothing and both invalid forms hold the frame; a
  rejected copy flush publishes nothing; fault injection on view/mapping/listener paths withholds
  the fence with no `uncaughtException`/`unhandledRejection`.
- Unit (`recordLockRpc`, `recordLockTransport`, `protocolCapabilities`): the barrier operation
  requires a node principal, validates database/table, and answers `{ position }`; exact-level slot;
  level 4 advertised, 3 refused; LMDB resolves the gate to `false`.
- End-to-end (`recordLockCluster.test.mjs`): exact convergence restored as regression coverage;
  deterministic: held apply on the successor's node → `waiters > 0` → release → predecessor's value
  read; a two-route topology where a table-excluding route advances the origin past `P` while the
  covering route is paused — waits, and answers 503 with the covering route removed; a real
  `restartNode()` with an idle origin whose dependency is durable — admits via one probe; a
  generation change — recovery probes every member and admits; a member stopped with
  `stopNodeProcess()` — recovery answers 503; a missing-structure record — poison, 503, copy
  clears; mixed-level 503 naming the level; single-node LMDB 503; crash windows before publication,
  after publication, and after `[seq]` re-converge.
