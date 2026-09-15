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
rejection into the retryable 503 the branch already uses. The transport therefore owes no timeout of
its own — only a wait that terminates, and a failure that is a rejection rather than a hang.

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
   reverse scan at all. Any design that asks a node for "your current log head" has to synthesize
   one by writing something.
5. **A peer's log domain is the *sending* peer's.** A relayed frame carries the relay's log key, not
   the original author's, so slot `[peer]` measures that peer's stream and nothing else. A
   dependency on an origin this node does not subscribe to directly cannot be evaluated in-domain.

## Chosen implementation

**Publish the apply-visible watermark, and capture positions locally.**

- Add `APPLIED_VERSION_POSITION` (slot 31) to the per-`(database, peer)` shared status buffer,
  advanced from each batch's `end_txn` `onCommit` to the received position that batch carried —
  including the empty `REMOTE_SEQUENCE_UPDATE` batches, which otherwise let `received` run away from
  `applied` for the whole idle period and strand every recovery barrier. The apply queue is FIFO per
  connection, so when a batch's `onCommit` runs, every earlier batch on that connection is committed
  and visible. `REPLICATION_SHARED_STATUS_SLOTS` grows from 32 to 40 to keep headroom; the buffer is
  process-local shared memory resolved through one accessor, which the slot map already documents as
  safe to grow.
- **Clean handoff:** for each `(origin, position)`, satisfied when `applied[origin] >= position`.
  `origin === thisNode` is satisfied by definition — a position in our own log is our own committed
  write. An origin with no shared-status buffer for this database is a dependency this node cannot
  evaluate, and the call **rejects** rather than admitting: core turns that into 503.
- **Recovery:** read `received[peer]` for every peer named in this database's `homeMap().homes`
  except this node, then wait for `applied[peer]` to reach each captured value, and return the
  captured pairs. This is exactly §7.2's "drain its inbound replication streams from every reachable
  member to the position each held at grant time" — the position **the local stream held**, which is
  what makes the barrier terminate: every captured position is already in the pipe.
- **Waiting.** Both modes check synchronously first and return without scheduling anything when the
  predicate already holds, which is the common case for a clean handoff whose predecessor released
  through the same stream. Otherwise one 10 ms timer per database drives every waiter on it; core's
  deadline ends the wait, so the barrier has no deadline of its own.
- **Coalescing** ("Concurrent recovery snapshots should be coalesced", `recordLockCoordinator.ts:277`)
  is satisfied structurally rather than with a batch object: a snapshot is a read of shared memory,
  so there is no per-snapshot round trip to share, and waiters on the same database already share one
  timer. Two concurrent recoveries capture two (possibly different) position sets and both are
  correct, because a later capture is `>=` an earlier one on a monotonic watermark.
- **Capability level 3 -> 4.** The release payload is now a versioned 7-tuple and admission now
  depends on a barrier a level-3 node does not run. The levels are mutually exclusive already
  (`protocolCapabilities.ts:82`), so bumping the constant is what keeps a level-3 peer out of the
  ring rather than silently admitting without a fence.

### Where this is weaker than §2, deliberately

Core's §7.2 already states two: an unreachable member's committed writes may not be visible, and a
predecessor's native commit submitted before expiry can settle after the barrier was measured. Three
more belong to this implementation and are documented rather than implied:

- **A dependency on a non-subscribed origin fails closed.** In a directional topology where this node
  never receives directly from a home-map member, every clean handoff naming that member rejects with
  503. That is correct but not useful; a mesh among `homes[]` is a practical precondition for
  enablement, and it is the same precondition the delegation RPC already wants.
- **The durable-release shortcut in §7.2 is not implemented.** "Prefers a durable release when one
  remains available" needs a bounded reverse read of the table's transaction log for the key's last
  `lockRelease`, and fact 4 above says there is no reverse scan on the v5 engine. Recovery always
  takes the drain path. Filed as a follow-up rather than improvised.
- **Deprecated LMDB does not satisfy the barrier.** `maxBatchTxnLogKey` is only adopted under
  `STORAGE_IS_ROCKSDB` (`replicationConnection.ts:6515`), so on LMDB the applied watermark advances
  in the sequence-id domain while the received watermark is a maximum over frame log keys. The
  barrier then does not converge and `lock()` answers 503. Record locks are a v5 feature; this is
  stated so the failure is legible rather than mysterious.

## Approaches considered

| Axis | Candidate | Ruling |
| --- | --- | --- |
| **Different layer** | Keep the barrier in core, and expose only the raw watermark to it. | Rejected. The watermark is per-`(database, peer)` shared memory owned by replication, and "reachable member" is a replication fact (a subscription exists and is applying), not a coordinator fact. Core's own note puts the boundary here for the same reason: "The transport does own the stream-specific apply-visible wait." |
| **Deeper cause** | Ask each member for its current log head over the record-lock RPC, then drain to that. | Rejected on fact 4: there is no log-head read on the v5 engine, so the member would have to commit a marker write per probe to synthesize one — a replicated write per recovery per member, on a path §10 already calls expensive. It also converts a local, always-terminating wait into one that depends on a peer answering. It buys the stronger "everything the member had committed", which §7.2 explicitly does **not** claim: the specified barrier is the position the local stream held. |
| **Do less** | Reuse `RECEIVED_VERSION_POSITION` as the fence and skip the new slot. | Rejected. Received is not applied: the entry is in the decode loop's hands, not the store's, so a successor can pass the barrier and then read the predecessor's pre-write value — the exact hazard §7.1 exists to close. It would make the barrier look implemented while guaranteeing nothing. |
| **Chosen** | Publish an apply-visible watermark per `(database, peer)`; evaluate clean dependencies against it, and capture recovery positions from the received watermark locally. | Uses the one fact replication already knows and core cannot (apply-visible progress per stream), terminates without a round trip, keeps the hot path at one `Math.max` per committed batch, and matches §7.2's wording for recovery rather than a stronger reading it does not make. |

## Testing

- Unit (`unitTests/replication/recordLockFreshness.test.mjs`): clean-handoff satisfied
  synchronously; clean-handoff satisfied after the applied watermark advances; self-origin
  dependency needs no peer; unknown origin rejects; recovery captures from `received`, waits on
  `applied`, and returns the captured pairs; recovery excludes this node; an empty dependency set is
  a no-op.
- Unit (`unitTests/replication/recordLockTransport.test.mjs`): the new slot's position and the
  grown buffer size; the disabled transport rejects `establishLockFreshness` with the enablement
  message.
- Unit (`unitTests/replication/protocolCapabilities.test.mjs`): level 4 is advertised and level 3 is
  refused.
- End-to-end (`integrationTests/cluster/recordLockCluster.test.mjs`): the concurrent-increment
  assertion goes back to **exact** convergence (`seen === [1..N]`). It was weakened in this PR's
  round 4/5 precisely because a handoff carried exclusion but not freshness; that is what this
  change restores, so the strong assertion is the end-to-end proof, and a regression in the barrier
  re-breaks it.
