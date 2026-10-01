# Cluster record locks: the operator-agreed home map (harper-pro#825, harper-pro#822)

The harper-pro half of core `resources/record-locks.md` §4. Core requires
`homeMap(database): LockHomeMap | undefined`, where `LockHomeMap = { generation, homes[],
homeIncarnation }` (`core/resources/recordLockCoordinator.ts`): an operator-published,
digest-agreed map, immutable per generation. This note covers the harper-pro mechanism behind it —
a durable `recordLockHomes` generation record, a peer digest check, the §4.3 change runbook
(stage → quiesce/fence → drain → activate), and `homeIncarnation` advanced per **coordination
incarnation** (§5.1). The planning rounds that shaped it are in harper-pro#822's description.

## The invariant this change enforces

**At most one generation is ever live, cluster-wide, for a given database's home map. Before
any node exposes generation `g+1` via `homeMap()`, every node capable of granting or honoring
`g` must have durably stopped doing so — immediately, not after a delay measured from an event
only that node observed — and the wait for any surviving authority to expire must be measured
from the _last_ such stop across the whole affected set, by a single external, trusted
timekeeper, not reconstructed independently by each node from its own clock.**

## Approaches considered

**Root cause:** a home map _derived_ by each node from data that can disagree, when core's contract
requires it to be _stated_ (published once, identically, and verified to be identical before use)
— and the _transition_ between two states of that fact must be governed by the same discipline:
stated and externally timed, not independently inferred by each participant.

| Axis                | Candidate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Why not chosen / why chosen                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Different layer** | Move home-map ownership into core.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Disqualified by core's own design (§4: "harper-pro owns this, because it owns topology").                                                                                                                                                                                                                                                           |
| **Deeper cause**    | Rebuild automatic, consensus-derived rehoming.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Rejected at the core-design level, with its disqualifier recorded there (§9).                                                                                                                                                                                                                                                                       |
| **Do less**         | (a) Global hot-reloadable config, no digest, no staged transition — skips §4.3 entirely. (b) A purely local per-node timer with no cross-node evidence — staggered delivery and non-immediate quiescence reopen the two-holder bug; a per-node clock cannot prove a cluster-wide elapsed-time fact. (c) Full affected-cluster stop/fence/wait/publish/restart, no online mechanism at all — valid, but costs full unavailability of every affected node for the drain window on every reconfiguration, not only the keys that moved. | (c) remains available as a documented manual fallback (an operator can always choose to stop every node instead of using `stage`) but is not the implementation: the online design below achieves the same safety without mandating a full-cluster outage, at the cost given in "The cost of this design" below.                                    |
| **Chosen**          | Durable per-database `{active, staged}` state, where **staging immediately and durably retracts `active`** (real quiescence, not observed-then-inferred); a **separate, explicit, operator-issued `activate`** call, timed by the operator's own external wall-clock wait from the _last_ stage/fence event across the whole affected set — not by any node's local clock; digest mismatch makes the whole map unavailable, not a shrunk ring.                                                                                       | Removes each counterexample the alternatives raise: quiescence is immediate and durable; the drain wait is anchored externally, by the operator, from the true last event, not reconstructed per node; no node's `Date.now()` is safety-load-bearing; a digest mismatch fails the whole map closed rather than admitting a shrunk, still-live ring. |

## The cost of this design, stated plainly

**A database's cluster record locks are fully unavailable, on every staged node, from the
moment `stage` is durably received until the operator issues `activate`** — not narrowed to
the keys whose home is moving. This is a direct consequence of "staging immediately retracts
`active`," and it is more availability cost than core's design prose suggests is necessary (it
describes quiescing only the nodes losing a key's ownership, implicitly). It is accepted because
anything less either reopens the two-holder bug (a local timer) or requires a canonical,
cross-node-synchronized partial-quiesce protocol, which is not built (narrowing the outage is the
open lever on harper-pro#856). The window lasts until the operator activates: the drain interval
(`DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS`) plus operator latency, or seconds when every node
proves its drain on stage (`record_lock_apply_homes` then activates immediately).

## Design

### 1. Durable storage — a dedicated local-only table, atomic per database

A system table, `hdb_record_lock_homes` (`getRecordLockHomesTable`), one row per `database`,
`LOCAL_ONLY` (defined with the same `table({ table: '…', database: 'system', attributes: […] })`
helper `hdb_nodes` uses; never replicated, never LWW-merged):

```ts
interface RecordLockGenerationState {
	generation: number;
	homes: string[];
	digest: string;
	stagedAt?: number; // staged only: the MIN_DRAIN_BACKSTOP_MS anchor
	quiesce?: string[]; // staged only: homes(g) ∪ homes(g+1), the ring this node stopped serving
}

interface RecordLockHomesRow {
	database: string; // primary key
	active?: RecordLockGenerationState;
	staged?: RecordLockGenerationState;
	highestActedOn: number; // monotonic floor: max(active?.generation, staged?.generation, highestActedOn), updated with every write, so a delayed stale `stage` cannot clobber a newer `staged`
	fenced: { node: string; operator: string; at: number }[]; // audit only; no grant path reads it
}
```

Every transition is a pure plan over the row's current state (`planStage`, `planActivate`), applied
inside `withRow`, which takes a node-scoped hold lock on the row and writes through that locked
handle (`_writeUpdate(…, { localOnly: true })`): the read a transition decides against and the
write that replaces the row are one cross-thread-exclusive critical section.

### 2. The operations API

Per-node operations in `replication/recordLockHomes.ts`, `super_user`-gated, Joi-validated,
mirroring `setNode.ts`'s shape: three mutating ones below, plus the read-only
`record_lock_propose_homes` ("Assembling a home map"). The `operator` on a `fenced[]` entry is the
authenticated principal (`operatorPrincipal`, `request.hdb_user.name`), never a request-body field.

- **`record_lock_stage_generation`** `{ database, generation, homes[], quiesce[] }` — issued by the
  operator on every node named in `homes(g) ∪ homes(g+1)`, which is what `quiesce` names (required
  since harper-pro#862: it is persisted on the staged row). Canonicalizes `homes[]` (sort, dedup)
  before storing or hashing. Refuses `generation ≤ max(active?.generation ?? 0,
staged?.generation ?? 0, highestActedOn)`, and refuses a `quiesce` that omits a node of any ring
  the row still remembers (`active.homes`, `staged.homes`, staged `quiesce`) — staging erases
  those rings, so an omitted node would be invisible to a later survey while it still grants. On
  success, **atomically**: computes `digest` (below), writes `staged`, and **clears `active`** —
  the durable write that makes this node stop granting under the old generation is the same write
  that records the new one is staged, so there is no window between "told about g+1" and "stopped
  granting under g." The HTTP response, once returned, is real quiescence evidence. Idempotent:
  identical `(generation, homes)` re-issued is a no-op success, except that a re-stage naming more
  participants widens the recorded `quiesce` to the union (never shrinks it); a different
  `homes[]` for a `generation` already staged is rejected.
- **`record_lock_fence_external`** `{ database, node }` — the operator's durable, audit-only
  attestation that an unreachable node has been stopped outside Harper. Appended to `fenced[]`
  on whichever node the operator is talking to. Consulted by no grant path — its safety is the
  operator's own action (the node is stopped), not anything Harper verifies.
- **`record_lock_activate_generation`** `{ database, generation, homes[] }` — issued by the
  operator, once, on every node in `homes(g+1)` (idempotent replay across nodes and across
  retries), **only after** the operator has, externally, in their own wall time: collected a
  successful `stage` (or `fence_external`) response from every node in `homes(g) ∪ homes(g+1)`
  — the whole `quiesce` set, which is wider than the set being activated — and then waited
  `DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS` from the _last_ such response. Refuses unless
  `staged` on this node matches `(generation, homes)` exactly (replay/consistency check — a stale
  or misdirected activate for the wrong transition is rejected, not silently applied). On success,
  atomically promotes `staged → active`, clears `staged`, updates `highestActedOn`. **No node
  measures the drain wait itself** — it cannot be proven by subtracting persisted wall times. The
  wait is the operator's externally-observed fact; nodes check _consistency_ (does this match what
  I staged?), and the only elapsed-time check is a `MIN_DRAIN_BACKSTOP_MS` (2 s) floor against this
  node's own `stagedAt` — defense in depth, not the safety mechanism.

  **Do not activate a departing node** — one in `quiesce` but not in `homes(g+1)`. Nothing stops
  you mechanically: `planActivate` never looks at membership and `homeMap()` does not require
  `self ∈ homes`, so the call succeeds and the leaver ends up with a defined home map naming the
  ring that replaced it. It still cannot lock. Every barrier it would need is refused by the new
  members, because `record_lock_barrier` admits only callers in the answering node's own home map
  (`recordLockRpc.ts` `executeBarrier`, `isMember`), and a generation change puts the leaver's
  next acquire on the recovery path, which asks **every** member for one
  (`recordLockFreshness.ts`, `dependencies === null`). So the lock fails 503 either way, and
  activating only moves the refusal from "no agreed home map" to a barrier the peers reject — the
  same outcome, reported worse. `record_lock_apply_homes` is the behavior to match: it marks such
  a node `role: 'departing'`, skips its activate, and `record_lock_transition` refuses a
  misdirected relay with a 409.

### 3. `homeMap()` — no storage I/O on the read path

Per thread, cache this node's active generation per database, updated **only** when this node's
own `active` row changes locally (on `stage` clearing it, or `activate` setting it) — never read
from storage, hashed or sorted inside `homeMap()` itself. Each call checks every peer named in
`homes` against shared-status slots 29 (capability) and 30 (digest agreement), failing closed when
either is unknown, and returns a new object. With `replication.recordLocks` off, no table watcher
or cache exists at all.

### 4. Digest mismatch fails the whole map closed, not a shrunk ring

Excluding a disagreeing peer from _this_ node's own ring does not prevent two arbiters — with
`homes = {A,B}`, a digest disagreement makes A derive ring `{A}` and B derive ring `{B}`, and
both self-home every key. So a digest mismatch with _any_ peer named in the active `homes[]`
makes `homeMap()` return `undefined` for the whole database on the observing node — core's own
existing "fails closed when no map is available" behavior, not a locally-recomputed smaller ring.
There is no ring recomputation at all, only "available" or "not."

### 5. Canonical digest encoding

Length-prefixed, not delimiter-joined, so `['A','B']` and `['A\0B']` cannot collide, over the
canonicalized (sorted, deduped) list; the generation is hashed as its decimal string, so
generations past 2³² stay distinct. The exact encoding is `digestOf`'s docstring and the bounds are
`validateGenerationInput` (both `recordLockHomes.ts`); `recordLockHomes.test.mjs` pins the
non-collision.

### 6. Wire: a dedicated digest message, not a `NODE_NAME` resend

Reusing `NODE_NAME` as a live refresh is unproven — its handler has side effects
(`sendSubscriptionRequestUpdate()`). So the digest travels on its own minimal message,
`RECORD_LOCK_HOMES_DIGEST` (`[150, digest, database]`), sent (a) at handshake per database and
(b) standalone, on every live outbound connection for a database whose local `active` digest just
changed (on `activate`) — with no other handshake side effect triggered. Receipt writes only a
tri-state match/mismatch/unknown result into the per-(database, peer) shared status buffer
(slot 30, beside slot 29's capability support flag) — the full digest itself travels on the wire,
compared byte-exact on the socket thread, never truncated into shared memory.

### 7. `homeIncarnation` per coordination incarnation, gated centrally

The gate lives in `recordLockOwnerFor` — the single function every ownership-assignment path
funnels through (`watchOwnerExit` and `subscriptionManager`'s `placeSubscription` both call it) —
rather than at each caller. On a genuine handoff (a new owner differing from a previously-live one
for that database) it confers live ownership only after `bumpHomeIncarnation()` has durably
persisted **and** every live worker has acknowledged fencing the departed owner's relayed handles
(`broadcastOwnerlessAndWait`, harper-pro#852). Until then the database is reported **unowned** to
every caller (`ownsRecordLockCoordination` returns false), never assigned under a stale
incarnation. A failure leaves it unowned and retries after `OWNER_FENCE_ACK_TIMEOUT_MS`.
Concurrent callers share one in-flight bump (`bumpInFlight`), so the read-increment-write in
`bumpHomeIncarnation` cannot race itself.

### 8. Wire/capability version bump

Every wire-shape change bumps the exact-match `recordLocks` level (this design moved it 2 → 3;
successor freshness moved it to 4). The levels and what each carries are documented on
`RECORD_LOCKS_CAPABILITY` (`protocolCapabilities.ts`).

### 9. Error containment

Every promotion write, socket announce, and worker-message/exit handler is wrapped so a
rejection cannot become an unhandled rejection on the main or a worker thread — persist first,
publish the local cache pointer only after persistence succeeds, and fail closed (leave the old
pointer or `undefined`) on any error in between.

## Testing

- Unit: `recordLockHomes.test.mjs` — canonicalization and digest determinism (including the
  `['A','B']` vs `['A\0B']` non-collision), input bounds, `planStage` (the floor including
  `highestActedOn` against a delayed stale `stage`, atomic retraction of `active`, the
  participant-set rules), `planActivate` (exact match, the backstop), `planProposal`, the stage
  drain report, and `withRow`'s row-lock exclusion. `recordLockTransport.test.mjs` — `homeMap()`
  withholding the whole map on a digest mismatch, an unknown digest or a wrong level;
  `recordLockOwnerFor` withholding ownership while a bump or fence ack is in flight, and leaving it
  unowned when the bump fails.
- Integration: `recordLockCluster.test.mjs`, "the §4.3 stage/activate transition" suite — no
  active generation fails every cluster lock closed; staging retracts any active generation
  immediately; activation is idempotent and refuses a generation that does not match what is
  staged.
- Not covered by any test: digest mismatch across real nodes (only the pure decision is
  unit-tested), `record_lock_fence_external`, a coordinating-worker or process restart exercising
  incarnation ordering under real IPC, and a persistence failure injected mid-bump.

## Assembling a home map: `record_lock_propose_homes`

A mutating bootstrap — a `record_lock_bootstrap_generation` that derives `homes` from `hdb_nodes`
and writes `active` for generation 1 directly, skipping stage/drain/activate on the grounds that the
node never had a home map — is easy to re-propose and wrong in both halves.

### Why deriving per node cannot be made safe by the digest check

The rejected design rested on "if two nodes derive different sets their digests differ, so
`homeMap()` is withheld on both." That is false. `homeMap()` iterates its **own** `active.homes`
(`recordLockTransport.ts`), so a node whose derived set is `[A]` has no peers to check, skips the
loop entirely, and serves its ring immediately. A and B with disjoint or merely incomplete views
each get a usable map and both arbitrate the same key. **A digest cannot detect a participant
omitted from the set being digested** — which is exactly what core §4.1 means by stated rather than
derived, and the reason that rule is about the _set_, not about the hash.

### Why no local guard can authorize a direct activation

The rejected design's other half was a fresh-state guard: no `active`, no `staged`,
`highestActedOn === 0`, therefore "this node has never granted, so there is nothing to quiesce."
True but insufficient — it proves a fact about _this_ node and says nothing about the cluster. A
node newly added to a cluster already active at generation 2 has an untouched row, passes the
guard, and activates its own generation 1 while every other node serves 2. Losing or deleting a
node's `LOCAL_ONLY` row reproduces the same false proof on a node that _had_ acted. Establishing
"no prior authority exists anywhere" is single-decree agreement — the thing harper-pro#825 deleted.

### What was built instead

`record_lock_propose_homes { database }`, `requiresSuperUser`, **read-only**. It returns the home
set this node's `hdb_nodes` view suggests (this node plus every row `shouldReplicateFromNode(row,
database)` accepts, canonicalized), the generation one past whatever this node has acted on, the
digest that pair would produce, the current `active`/`staged`, `quiesce`, and warnings. It writes
nothing and notifies nothing.

`quiesce` is §4.3's `homes(g) ∪ homes(g+1)` — the union of the proposal with this node's current
active and staged rings — and it is returned as a field because staging only the nodes in `homes`
omits, on a **shrink**, the node being removed. That node is never staged, keeps its old active generation, and keeps granting while the new ring grants too —
two arbiters. A departing node must still be
staged or `record_lock_fence_external`'d and drained; `quiesce` names exactly that set, and a
warning names the leaving nodes explicitly.

Two further limits are stated in the response rather than left for an operator to discover:

- **`quiesce` is only as complete as the node that answered.** It unions this node's own `active`
  and `staged` rings, so a node that has neither — never bootstrapped, or already staged, since
  staging retracts `active` — cannot name a ring the rest of the cluster is serving, and the union
  silently omits it. The response warns when this node has no `active` generation and says to ask a
  node that holds it and union the proposals. This is inherent to a single-node read, not a defect
  to be patched: a proposal that reached across nodes to find the old ring would be the
  cross-node agreement step §4.3 deliberately leaves with the operator.
- **A staged departing node stays unable to lock.** It is never activated, because it is not in
  `homes`; it holds `staged` with no `active` and refuses every cluster lock. That is what leaving
  the ring means, and the warning says so, so it is not mistaken for a stuck transition. Bringing
  such a node back is an ordinary later generation that names it again.

That is the list-assembly step of the §4.3 runbook and only that: the operator captures one
canonical list instead of typing it, then passes that exact list to `record_lock_stage_generation`
on every node in `quiesce` and to `record_lock_activate_generation` on every node in `homes`,
unchanged. What a script compares across nodes is `homes`, **not** the returned `digest`: the digest
is taken over `(generation, homes)` and every node proposes its own floor plus one, so two nodes that
agree on membership still differ here whenever their floors do. Pass the highest `generation` returned
to every node; the digest they then agree on is the one computed from that single list, and that is
the one `stage` and `activate` check. Because this operation is a read, none of the blockers
above apply to it — a suggestion that is wrong costs an operator a re-run, not two arbiters.

The generation it returns is one past this node's own floor, so the same operation serves a
topology change as well as a first bootstrap. It is still only this node's view; agreement remains
the operator's act.

### Approaches considered

| Axis                | Candidate                                                                                                                        | Ruling                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Different layer** | Derive the ring inside `homeMap()` when no row exists, so nothing has to be called.                                              | Rejected — §4.1's two-arbiter bug, and now with a concrete mechanism: the agreement loop cannot see a node it was never told about.                                                                                      |
| **Deeper cause**    | A mutating bootstrap that writes `active` for generation 1 behind a fresh-state guard.                                           | Rejected on the two counterexamples above. Making it safe would require asking every derived peer whether it already has authority and failing closed on any unreachable one — single-decree agreement, deleted by #825. |
| **Deeper cause**    | One orchestrating call that fans stage → wait → activate out to every node.                                                      | Built later as `record_lock_apply_homes` (next section): over an explicit node list, with a node-principal hop instead of delegated credentials.                                                                         |
| **Do less**         | Document a script that reads `cluster_status` on each node and assembles the list.                                               | Close, and what an operator can do today; the operation adds canonicalization, the digest, the current state and the bounds validation in one authenticated call, with no new authority.                                 |
| **Chosen**          | A read-only proposal: derive, canonicalize, hash, report — the operator still stages and activates the returned list everywhere. | Removes the typing, which was the actual ask, while leaving every authority-bearing step exactly where §4.3 already put it.                                                                                              |

## Applying a home map across the cluster: `record_lock_apply_homes` (harper-pro#862)

`record_lock_propose_homes` removed assembling the list by hand; it did not remove the N×2 loop of
`record_lock_stage_generation` on every node in `homes(g) ∪ homes(g+1)` followed by
`record_lock_activate_generation` on every node in `homes(g+1)`, with the operator carrying one
identical list to each and deciding when the drain is done. This section adds the single
operator-facing call that drives that §4.3 transition, **given an explicitly supplied list of
expected nodes**. Everything the two rejections above established still holds: the list is stated,
never derived, and this operation orchestrates without ever authorizing policy.

### The invariant this change enforces

**No node stages or activates a generation this call did not verify against every node the operator
named, and no node activates `g+1` while any node in `homes(g) ∪ homes(g+1)` is unreachable, has not
staged it, or has neither proven quiescence nor been covered by an operator-attested drain wait that
began after that node was staged.** The failure direction of every partial outcome is refusal: a
half-applied call leaves some nodes quiesced (their cluster locks 503) and none double-granting.

### Why the explicit list is what makes orchestration safe

A digest cannot detect a participant omitted from the set being digested ("Why deriving per node
cannot be made safe by the digest check", above). When the operator states the set there is nothing to omit, so "ask every named node, refuse if any does not
answer" becomes a _complete_ check, and unreachable becomes a hard failure rather than a skipped
peer. That is the whole difference between this operation and the rejected one.

### The operation

`record_lock_apply_homes { database, homes[], quiesce?[], generation?, drained? }`, `requiresSuperUser`,
`replication/recordLockApply.ts`. One apply runs at a time per database on the worker that takes the
call (a second worker or node racing it is kept safe by the row-level planners, and the loser's retry
succeeds by naming a higher generation); hops fan out at most 16 at a time, each under a deadline
that also retires the pending request on the wire — the live session drops its response entry and
the fallback connection closes its socket — so a peer that accepts and never answers cannot pin a
socket per apply.

- `homes` is the new ring, `homes(g+1)`. `quiesce` is §4.3's `homes(g) ∪ homes(g+1)` — the full set of
  nodes that must stop granting before anything activates — and defaults to `homes`. It must be a
  superset of `homes`; the shape is exactly what `record_lock_propose_homes` returns, so its output can
  be passed straight in. A node in `quiesce` but not `homes` is **departing**: it is staged (so it stops
  granting) and deliberately never activated, so it stays unable to lock, which is what leaving the
  ring means. The manual `record_lock_activate_generation` would _accept_ an activate on such a node —
  §2 says why you should still not send one: it does not restore the node's ability to lock, it only
  changes which refusal the operator sees.
- `generation` is optional on a first call: one past the highest generation any surveyed node has acted
  on — unless the node at that highest generation holds exactly the requested set, in which case that
  generation is resumed, so a retry of an interrupted call continues the same transition rather than
  opening a new one. (The list is never derived; only the number is.) It is **required** with `drained`.
- `drained` is the operator's attestation that the drain interval has elapsed (see "Activation").

**Phase 1 — survey (reads only).** Ask every node in `quiesce` for its row (`active`, `staged`,
`highestActedOn`) and its own name; the initiating node answers itself locally, and when it is not
itself in `quiesce` its own row is read too (reported as `initiator`, never written) — a ring the
node taking the call serves is as much a participant as a peer's. Refuse, before anything is
written, if:

| Condition                                                                                                                               | Why it refuses                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any named node does not answer, or answers under a different name                                                                       | completeness is the point of the list; a misrouted `hdb_nodes` URL is an unanswered node. A peer too old to have `record_lock_transition` fails here, before any stage                                                                                                                                                                                            |
| any node reports a ring member not in `quiesce` — in `active.homes`, `staged.homes`, or the `quiesce` its `staged` row was written with | "you forgot a node that is still granting". Staging retracts `active`, so a staged node's row no longer names the old ring; the `quiesce` persisted on stage is what still does, which is what makes a retry with a shorter list refusable                                                                                                                        |
| a surveyed `staged` row has no recorded `quiesce`                                                                                       | it was staged by a stage that did not name its participants (a row from before this change), so the ring it stopped serving cannot be checked against the list; the operator re-stages the same generation and set with `quiesce` on that node, which backfills it                                                                                                |
| nodes disagree about `active` (two distinct `(generation, digest)`)                                                                     | two rings are being served; §4's whole-map-fails-closed rule already withholds locks on such nodes. A disagreement about `staged` is not refused here: it is judged by the next row, so an explicit higher generation supersedes two sets that two racing operators staged (otherwise the cluster would stay quiesced until someone used the per-node operations) |
| `planStage` would reject the target on a node that is not already active at it                                                          | a staged different set for the same generation, or a generation below that node's floor; the same pure decision the per-node operation makes, run as a dry run                                                                                                                                                                                                    |

A node already `active` at exactly the target `(generation, digest)` is past the transition: it is not
staged again (`planStage` would refuse a generation at its floor) and its activate is the idempotent
noop. This is what lets a call interrupted between two activations be re-run unchanged.

**Phase 2 — stage everywhere.** Every node in `quiesce` that is not already active at the target
stages `(generation, homes)` with `quiesce`, which `record_lock_stage_generation` now requires and
persists on the staged row. Each answer is that operation's result: the staged state plus `quiesced`, the drain from
harper-pro#856. Idempotent on retry (`planStage`'s noop branch), and the noop still drains, so a retry
re-collects evidence. A hop that fails leaves the other stages in place — more staged nodes only move
the cluster further toward refusal — and the call reports every node's state with a 503 rather than
activating anything.

**Phase 3 — activation.** Only when every node in `quiesce` has staged the target (or was already
active at it). `provesQuiescence()` — the drain reached the coordinating thread, was complete, and found
nothing outstanding — is the only predicate that licenses skipping the interval, and it is checked per
node. If it holds for every freshly staged node, the call waits out `MIN_DRAIN_BACKSTOP_MS` from the last
stage response (the per-node backstop would otherwise refuse an activate that lands within 2 s of that
node's own stage) and activates `homes`. Otherwise it does **not** activate: it returns
`outcome: 'staged'`, the per-node drain results, and `retryAfterMs` — the drain interval, to be measured
by the operator from receiving the response and never assembled from node clocks (an
absolute time from a node whose clock is behind is already past). The second call carries the reported
`generation` and `drained: true`. It re-surveys, re-stages (noops that drain again), and then activates
whether or not the drain proves — **but only for nodes that were already staged at the target when
this call surveyed them.** A node this call had to stage has had no interval at all, so the attestation
cannot cover it (A and B staged, C's stage failed, the wait passes, the
retry stages C, and C may still hold an old delegation); the call reports `staged` with a fresh
`retryAfterMs` instead. The attestation is not a new authority: it is exactly the external wall-clock
wait §4.3 always made the operator's job, carried on the call — and it has to exist, because the
fallback is otherwise unreachable through this operation. Core's `unprovenOwnershipMs`
(`recordLockCoordinator.ts`) makes a freshly built coordinator unable to prove anything for a full
lease, and a database nothing has locked has no coordinator to attest from at all. A single HTTP
request never holds for the interval.

**Retry contract.** The same call, unchanged (plus `generation` and `drained: true` after a wait), is
safe to repeat from any state this operation can leave behind, and completes the transition:

| State after an interrupted call        | What the retry does                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| nothing staged (refused at survey)     | nothing was written; fix the list and call again                                                                                               |
| some nodes staged, some not            | survey allows it (staged rows all equal the target); stages the rest; noops re-drain the first; an attestation does not cover the newly staged |
| all staged, none active                | noops everywhere, then activates if proven or attested                                                                                         |
| some active at the target, some staged | already-active nodes skip the stage and noop the activate; the rest complete                                                                   |
| all active                             | every phase noops; `outcome: 'activated'`                                                                                                      |

Every response and every error body carries `nodes`, one entry per node in `quiesce`, with what each
phase found or did on it (`survey`, `stage`, `activate`, each with its own `error` when the hop failed) —
never a bare boolean. Refusals are 409 (policy) or 503 (unreachable, or a hop failed after staging began);
the error body is the same report. Two operators applying concurrently from different nodes cannot
double-grant: each node's `planStage` refuses a second set at the same generation, so one of them
reports `incomplete` and re-runs.

### Auth for the hop

`sendOperationToNode` and the live subscription session both connect with mTLS, so a peer authenticates
the caller as a **node principal**, not as `super_user`. The operator's credentials are never forwarded.
Instead a peer-callable operation, `record_lock_transition { database, action: survey | stage |
activate, generation, homes, quiesce, digest }`, is accepted only from a node principal — the same
`principalNodeName` gate `record_lock_delegate` / `record_lock_recall` / `record_lock_barrier` use — and
its handler **re-validates locally before writing**: the generation and sets through the shared
validator, the digest by recomputing it and refusing a mismatch, its own place in the transition (it
stages only as a node named in `quiesce`, activates only as a member of `homes` — so a misdirected
activate can never turn a departing node back into a granter), and its own row through the same
`planStage` / `planActivate` decisions the per-node operations run. The principal relays a proposal
each node independently verifies; it never authorizes policy.

What that makes the gate _for_:
`replicationConnection.ts` dispatches an inbound operation as `server.operation(data, { user },
!isAuthorizedNode)`, and a caller with an `hdb_nodes` row bypasses `verifyPerms` entirely — so a node
principal could already invoke the `requiresSuperUser` per-node operations over the wire. The
peer-callable operation is therefore not what lets a peer write; it is what keeps a `super_user` HTTP
caller from driving the relay under a node's name (`principalNodeName` refuses anyone not in
`server.nodes`), and its local re-validation is what keeps a peer from pushing a set this node did not
verify. A departed-but-still-known node principal keeps that pre-existing authority; this operation
neither widens nor narrows it.

#### What that admits, stated plainly, and why it is accepted here

The honest reading of the paragraph above is that **a home-map transition is authorized by node
identity alone**. Nothing on the wire proves an operator asked for it. So any principal a peer
resolves through `principalNodeName` — a compromised cluster node, or a `super_user` on any single
node exploiting the same "authenticated user named like a node" gap that `record_lock_delegate`
already has — can stage and then activate a map of its choosing on a peer.

That is not a small consequence: the map decides which node arbitrates which key, and two nodes
serving different maps is precisely the two-arbiter failure §4 exists to prevent. The digest check
narrows the blast radius rather than closing it — `homeMap()` iterates its **own** `active.homes`, so
a node rewritten to a singleton skips the peer loop and serves immediately, and a peer fails closed
only once the changed digest reaches it over a live connection.

It is accepted for this release, by the task owner's ruling on #822, on three facts:

1. **A cluster node principal is already trusted to write replicated data on every peer.** The relay
   extends that existing trust to home-map policy; it does not open a new channel.
2. **This operation does not widen the authority.** The per-node operations were reachable by a node
   principal through the dispatcher bypass before harper-pro#862 added the relay. What the relay adds
   is the local re-validation above — strictly more checking than the direct call it replaced.
3. **Nothing shipped is exposed.** `replication.recordLocks` is off by default and grants nothing
   until an operator stages and activates a generation, so reaching this needs an operator to have
   enabled and activated the feature _and_ an attacker to hold a node principal.

What would close it is an operator-delegated proof carried on the transition — a short-lived
capability or signed manifest minted by the `record_lock_apply_homes` caller's own `super_user`
session, covering `(database, generation, digest, quiesce)` and an expiry, verified by each receiving
node before it writes — with the node-principal gate kept as transport authentication. That is filed
as harper-pro#869 and is a prerequisite for recommending this feature in production, and for #853's
default-on question. The dispatcher's node-wide `verifyPerms` bypass is wider than record locks and
wants its own assessment; #869 says so rather than folding it in.

### Approaches considered

| Axis                | Candidate                                                                                                                                                                                                                                                                                                                         | Ruling                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Different layer** | Orchestrate outside Harper: a script or CLI that authenticates to every node and drives the per-node operations, with a read-only survey added.                                                                                                                                                                                   | Valid as a manual fallback, and the per-node operations stay for exactly that. Not chosen because it cannot express "unreachable is a hard failure" for a node the script's credentials cannot reach, cannot persist the participant set anywhere the survey can find it again, and carries the operator's secret to N nodes per call. |
| **Deeper cause**    | Derive the set (from `hdb_nodes`, or by agreement), so no list is needed.                                                                                                                                                                                                                                                         | Rejected twice already, above, with the mechanism recorded: a digest cannot detect an omitted participant, and no local state proves the absence of prior authority. Not reopened.                                                                                                                                                     |
| **Do less**         | Forward the operator's credentials per hop and reuse the existing `requiresSuperUser` operations unchanged.                                                                                                                                                                                                                       | Rejected: the operator's secret in flight to N peers per call is a new exposure for no gain, and — the fact above — the hop is authenticated as a node principal anyway, so what actually has to exist is the receiving node's own re-validation, not a forwarded permission.                                                          |
| **Do less**         | Stage-and-activate in one call with a fixed wait, no drain evidence.                                                                                                                                                                                                                                                              | Rejected: holds an HTTP request for ~6 minutes, and the drain (#856/#861) already exists to make that wait unnecessary in the planned case.                                                                                                                                                                                            |
| **Manifest**        | A manifest-backed transition: persist `{generation, digest, homes, quiesce, transitionId}`, return a receipt, refuse an attested retry that staged anything new.                                                                                                                                                                  | Adopted except the identifier: `quiesce` is persisted on the staged row, the wait is relative, the attestation covers only nodes already staged at survey. A `transitionId` would be a second identity `planStage`/`planActivate` never check; `(generation, digest)` is already exact.                                                |
| **Chosen**          | One `super_user` call: survey → refuse on any incompleteness → stage everywhere (persisting `quiesce`) → activate immediately on proof, else report a relative wait and let an attested second call finish what was already staged. A node-principal peer operation that re-validates, including its own place in the transition. | The only shape that makes "unreachable is a hard failure" expressible while keeping every authority-bearing decision on the node that owns the row.                                                                                                                                                                                    |

### Not in scope

A survey-only dry run (`plan: true`) is cheap — phase 1 is already factored as a pure decision over
the survey — but it changes the operation's contract and is not built.
Narrowing the outage to only the keys whose home moves remains the open lever on harper-pro#856.
`record_lock_propose_homes` stays the read-only helper that suggests a list. `homeMap()`, the
freshness barrier and the poison rules are untouched; nothing here runs on a lock path.

### Testing

- Unit (`recordLockApply.test.mjs`): the survey decision — unreachable, wrong self-name, an unlisted
  ring member including one only a staged row's persisted `quiesce` still names or one the initiating
  node's own row names, a staged row with no recorded participants, active disagreement, two raced
  staged sets superseded by an explicit generation, resume of an in-flight generation, already-active
  nodes skipping the stage; a hop that never answers failing at its deadline; the activation decision — proof on every node activates, one
  unproven node withholds with a relative wait, the attestation covers only nodes already staged at
  survey; the orchestrator over fake peers — no stage is sent after a refusal, departing nodes are
  staged and never activated, a hop failure mid-stage or mid-activate reports every node and the retry
  completes, an attested call that staged a node itself reports `staged` again; the peer operation —
  403 without a node principal, a digest mismatch refuses, a node not named in `quiesce` refuses to
  stage and one outside `homes` refuses to activate, and the write goes through the per-node planners.
- Cluster integration, two files so each shards on its own (both wait out core's lease once, ~6
  minutes, to reach a provable drain; the wait is setup, not the outage). `recordLockApplyHomes.test.mjs`:
  one call, no attestation, bootstraps generation 1 on a fresh three-node cluster whose coordinators
  can prove, and locks work with no per-node loop; refusal before staging on an unlisted ring member,
  a staged mismatch, and a stopped node. `recordLockApplyRetry.test.mjs`: a call without `drained` on a
  cluster that cannot prove reports `staged` with `retryAfterMs` and locks are 503 until the attested
  call; a failure injected between stage and activate leaves every node staged and refusing, and the
  same call from another node completes it; an attested call that had to stage a node itself reports
  `staged` again; the peer hop refuses an operator caller; a topology change activates in seconds once
  every node proves, with the departing node staged and never activated; a list that omits the node
  taking the call, or the ring a staged node was drained for, is refused.
