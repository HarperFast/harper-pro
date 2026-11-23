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
	fenced: { node: string; operator: string; at: number; generation?: number; fencedWith?: string[] }[]; // no grant path reads it. An entry with `generation`/`fencedWith` (the stage and fenced set of the `record_lock_apply_homes` call that recorded it) is also admission evidence for that call's retries ("Fenced nodes"); only that stage may write one
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
authenticated principal (`operatorPrincipal`: `hdb_user.username`, or a node principal's `name`), never a
request-body field. The one exception is the `record_lock_transition` stage hop, which carries the
initiator's principal as `operator` and records it as `"<operator> via <relaying node>"`.

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
`homes` against shared-status slots 31 (capability) and 32 (the digest that peer last advertised,
compared with this thread's own), failing closed when either is unknown, and returns a new object. With `replication.recordLocks` off, no table watcher
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
`RECORD_LOCK_HOMES_DIGEST` (`[150, digest, database]`), sent (a) at handshake per database,
(b) standalone on every live session of a database, inbound and outbound, whose local `active`
digest just changed, and (c) on each keepalive ping of an outbound session — with no other handshake
side effect triggered. Receipt stores the digest's first 64 bits in the per-(database, peer) shared
status buffer (slot 32), one `Atomics` value, so it cannot tear; a malformed frame stores nothing.
Agreement is that value equal to the reading thread's own digest, decided when `homeMap()` reads it:
a stored verdict is relative to the writing thread's cache and to whichever of the peer's sockets
that thread holds, so one thread's stale view overwrites another's correct one. Sockets of one peer
land on different threads, so an older frame can be recorded after a newer one; (c) bounds that to
one ping interval.

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
digest that pair would produce, the current `active`/`staged` and the row's `fenced` audit list, `quiesce`, and warnings. It writes
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
began after that node was staged — except a node the operator names in `fenced` as stopped outside
Harper ("Fenced nodes").** The failure direction of every partial outcome is refusal: a
half-applied call leaves some nodes quiesced (their cluster locks 503) and none double-granting.

### Why the explicit list is what makes orchestration safe

A digest cannot detect a participant omitted from the set being digested ("Why deriving per node
cannot be made safe by the digest check", above). When the operator states the set there is nothing to omit, so "ask every named node, refuse if any does not
answer" becomes a _complete_ check, and unreachable becomes a hard failure rather than a skipped
peer. That is the whole difference between this operation and the rejected one.

### The operation

`record_lock_apply_homes { database, homes[], quiesce?[], generation?, drained?, fenced?[] }`, `requiresSuperUser`,
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
- `fenced` names nodes of `quiesce` the operator attests are stopped outside Harper (harper-pro#973).
  It must be a subset of `quiesce`, disjoint from `homes`, and must not name the node taking the call;
  each violation is a 400 before any hop. `fenced: []` is the same as omitting it. See "Fenced nodes".

**Phase 1 — survey (reads only).** Ask every node in `quiesce` for its row (`active`, `staged`,
`highestActedOn`) and its own name; the initiating node answers itself locally, and when it is not
itself in `quiesce` its own row is read too (reported as `initiator`, never written) — a ring the
node taking the call serves is as much a participant as a peer's. Refuse, before anything is
written, if:

| Condition                                                                                                                                                                                                         | Why it refuses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any named node that is not fenced does not answer, or answers under a different name                                                                                                                              | completeness is the point of the list; a misrouted `hdb_nodes` URL is an unanswered node. A peer too old to have `record_lock_transition` fails here, before any stage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `fenced` is non-empty and a surveyed node does not report `supportsFenced`                                                                                                                                        | an older node accepts the stage hop's `fenced`/`operator` fields unread (`validateBySchema` allows unknown keys), so it would stage without recording the fence, and its home would keep the stopped node's grants for a full lease. Upgrade it, or apply without `fenced`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| a fenced node with no `active` ring holding it that a strict majority of that ring's members report active, or with any known ring of only fenced nodes, and no fence for it recorded at this transition's target | a fenced node is not surveyed, and if it comes back serving its old map only a peer in that map's ring can disagree. One survivor's `active` ring does not show the fenced node's last ring: the fenced node may itself have fenced that survivor out earlier, while the survivor was down. Any two majorities of a ring share a member, and that member, having taken part in an earlier fenced transition, reports a different `active` ring (refused as a disagreement) or none (staged, so it does not count toward the old ring's majority). A transition admitted this way can therefore never be followed by one from the opposite minority. A staged ring is no anchor, since the fenced node may never have staged it. A retry, including one after activation, passes on the fence an earlier call recorded at the same target generation and digest, for a fenced set that covers this call's, so fences recorded by separate calls cannot add up to a witness neither had |
| any node reports a ring member not in `quiesce` — in `active.homes`, `staged.homes`, or the `quiesce` its `staged` row was written with                                                                           | "you forgot a node that is still granting". Staging retracts `active`, so a staged node's row no longer names the old ring; the `quiesce` persisted on stage is what still does, which is what makes a retry with a shorter list refusable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| a surveyed `staged` row has no recorded `quiesce`                                                                                                                                                                 | it was staged by a stage that did not name its participants (a row from before this change), so the ring it stopped serving cannot be checked against the list; the operator re-stages the same generation and set with `quiesce` on that node, which backfills it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| nodes disagree about `active` (two distinct `(generation, digest)`)                                                                                                                                               | two rings are being served; §4's whole-map-fails-closed rule already withholds locks on such nodes. A disagreement about `staged` is not refused here: it is judged by the next row, so an explicit higher generation supersedes two sets that two racing operators staged (otherwise the cluster would stay quiesced until someone used the per-node operations)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `planStage` would reject the target on a node that is not already active at it                                                                                                                                    | a staged different set for the same generation, or a generation below that node's floor; the same pure decision the per-node operation makes, run as a dry run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

A node already `active` at exactly the target `(generation, digest)` is past the transition: it is not
staged again (`planStage` would refuse a generation at its floor) and its activate is the idempotent
noop. This is what lets a call interrupted between two activations be re-run unchanged.

**Phase 2 — stage everywhere.** Every node in `quiesce` that is not fenced and not already active at the target
stages `(generation, homes)` with `quiesce`, which `record_lock_stage_generation` now requires and
persists on the staged row. Each answer is that operation's result: the staged state plus `quiesced`, the drain from
harper-pro#856. Idempotent on retry (`planStage`'s noop branch), and the noop still drains, so a retry
re-collects evidence. A hop that fails leaves the other stages in place — more staged nodes only move
the cluster further toward refusal — and the call reports every node's state with a 503 rather than
activating anything.

**Phase 3 — activation.** Only when every node in `quiesce` that is not fenced has staged the target
(or was already active at it). `provesQuiescence()` — the drain reached the coordinating thread, was complete, and found
nothing outstanding, or only recalls to fenced nodes ("Fenced nodes") — is the only predicate that
licenses skipping the interval, and it is checked per node. If it holds for every freshly staged node, the call waits out `MIN_DRAIN_BACKSTOP_MS` from the last
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

| State after an interrupted call        | What the retry does                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nothing staged (refused at survey)     | nothing was written; fix the list and call again                                                                                                                                                                                                                                                                                                           |
| some nodes staged, some not            | survey allows it (staged rows all equal the target); stages the rest; noops re-drain the first; an attestation does not cover the newly staged                                                                                                                                                                                                             |
| all staged, none active                | noops everywhere, then activates if proven or attested                                                                                                                                                                                                                                                                                                     |
| some active at the target, some staged | already-active nodes skip the stage and noop the activate; the rest complete                                                                                                                                                                                                                                                                               |
| all active                             | every phase noops; `outcome: 'activated'`                                                                                                                                                                                                                                                                                                                  |
| fenced transition, retried             | a survivor already active at the target is not staged again and records nothing; its row has the fence only if the call that staged it carried one. The retry must carry the same `fenced`: dropping it with the node still in `quiesce` is 503 unreachable, dropping the node from `quiesce` is 409, since the survivors' staged `quiesce` still names it |

Every response and every error body carries `nodes`, one entry per node in `quiesce`, with what each
phase found or did on it (`survey`, `stage`, `activate`, each with its own `error` when the hop failed) —
never a bare boolean. Refusals are 409 (policy) or 503 (unreachable, or a hop failed after staging began);
the error body is the same report. Two operators applying concurrently from different nodes cannot
double-grant: each node's `planStage` refuses a second set at the same generation, so one of them
reports `incomplete` and re-runs.

### Fenced nodes (harper-pro#973)

Without `fenced`, a permanently stopped member of the current ring blocks every transition: listing it
in `quiesce` is 503 unreachable, omitting it is 409 because survivors' rows still name it. `fenced` is
the operator's statement "this node is stopped outside Harper", carried on the one call. Harper does
not verify it; the trust model is the same as `record_lock_fence_external`, which this extends. Isolating a node never qualifies, however long ago: a partitioned node that is still running keeps its digest agreement and keeps homing its own keys under `g` (below). Stop the Harper process first.

- **Survey and stage skip fenced nodes**, which still count as named for the unlisted-member check.
  The report gives them `role: 'fenced'` and no `survey`/`stage`/`activate`.
- **Each survivor that this call stages records the fence with its stage.** The stage hop carries `fenced` and `operator`
  (the authenticated caller on the initiating node). `stageGeneration` appends one
  `{node, operator, at, generation, fencedWith}` entry per fenced node to the row's
  `fenced[]` inside the same `withRow` write as `staged`, deduplicated on `(node, generation,
fencedWith)` so retries of the same call do not grow it. A noop re-stage that adds a fence still writes. A relayed hop records the operator as
  `"<operator> via <relaying node>"`: the node principal can already run any operation on a peer
  ("What that admits", below), so the relay is named rather than trusted silently. The receiving node
  re-validates the same three rules.
- **Activation.** `provesQuiescence(quiesced, fenced)` treats one more drain result as proof: a
  `complete: false` drain whose `outstanding` entries are all home-side recalls (`delegate` set) naming
  a fenced node. A survivor that granted the stopped node a delegation can never get that recall
  confirmed, so without this the immediate path would almost never fire. Every other incompleteness
  (no `delegate`, an empty list, a malformed entry, an error) still withholds. When every survivor
  proves, the call activates at once; otherwise it is the ordinary `staged` + `retryAfterMs` path,
  and the attested retry must carry the same `fenced`.

Why each kind of authority the fenced node `C` held under `g` cannot admit after the survivors
activate `g+1`:

| `C`'s authority under `g`                         | Why it cannot admit                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| delegations `C` holds, granted by a survivor home | `C` is stopped: the operator's attestation, and the only fact the recall discount relies on. Core's home expires an older grant its stage drain reported outstanding to a node outside the new ring (the recall to `C`) on its first grant under `g+1` (`#retireOlderGrants`), so the key is served at once rather than after the lease                                                                                             |
| delegations `C` granted to survivors              | the survivor's own drain surrenders them, which is part of its proof                                                                                                                                                                                                                                                                                                                                                                |
| a grant reply from `C` still in flight            | a staged survivor has no home map, so core's post-reply check (`reply.token[0] !== homeMap()?.generation`) hands it back; after activation the token's generation is `g`                                                                                                                                                                                                                                                            |
| a delegation request from `C` still in flight     | refused for no map while staged, and for generation or `unknown-node` after activation                                                                                                                                                                                                                                                                                                                                              |
| `C` restarts with its old `active` row            | the per-peer digest record (slot 32) is process memory, so a restarted `C` starts with none. The survey of this transition (this call's, or the earlier call whose recorded fence a retry passes on) required a majority of `C`'s ring to report it active, so `C`'s row holds that ring and its live members now announce `g+1`; §4 withholds `C`'s whole map. It cannot lock until a later generation that includes it is applied |

A `C` that is actually alive and partitioned keeps its retained peer digest records and self-homes its own
keys under `g` whether or not the call waits, so the attestation was already load-bearing on the wait
path; the immediate path adds reliance only for the delegations `C` held. Writes `C` committed and never
replicated are lost or arrive late on either path.

**Minority survivors get a 409.** A 2-node cluster that lost one node, or a 3-node cluster that lost
two, cannot use `fenced`: no majority of the old ring answers. Without the majority rule, each side of a
flip-flop (b down, a fences b; later a down, b restarts on its old row and fences a) would activate a
ring of one, and both would grant. The majority is counted only over rings that
`record_lock_apply_homes` activated; a ring activated with the per-node operations on a node set that
never staged it (which §4.3's runbook already forbids) can still anchor wrongly. A fenced call after an
unfenced one is refused too: that call's stage erased the survivors' `active` ring and recorded no fence.

The refusal names the per-node recovery (`manualRecovery`): the stage and activate bodies, their nodes
and the drain wait, valid only while every fenced node stays down for good, since a lease wait does not
stop a restarted one serving its old ring. Its generation is the call's resume target when every
surveyed node accepts it, so a re-send during the wait names the same steps. `remove_node` retires no
node from a ring: it stops replication, and a removed node that runs again still holds its `active` row.

A fenced node that comes back is not re-admitted by this call: its `active` disagrees with the
survivors', so a later apply that lists it refuses at survey ("nodes disagree about the active
generation") until that node is re-staged with the per-node operation.

### Auth for the hop

`sendOperationToNode` and the live subscription session both connect with mTLS, so a peer authenticates
the caller as a **node principal**, not as `super_user`. The operator's credentials are never forwarded.
Instead a peer-callable operation, `record_lock_transition { database, action: survey | stage |
activate, generation, homes, quiesce, digest, fenced?, operator? }`, is accepted only from a node principal — the same
`principalNodeName` gate `record_lock_delegate` / `record_lock_recall` / `record_lock_barrier` use — and
its handler **re-validates locally before writing**: the generation and sets through the shared
validator, the digest by recomputing it and refusing a mismatch, its own place in the transition (it
stages only as a node named in `quiesce`, activates only as a member of `homes` — so a misdirected
activate can never turn a departing node back into a granter), and its own row through the same
`planStage` / `planActivate` decisions the per-node operations run. The principal relays a proposal
each node independently verifies; it never authorizes policy.

What that makes the gate _for_:
`replicationConnection.ts` dispatches an inbound operation as `server.operation(data, { user: authorization },
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

The transition needs the same authority as any other cluster fan-out, and it does not widen the trust
boundary:

1. **A node principal can already run any operation on a peer.** `replicationConnection.ts`
   dispatches an inbound operation as `server.operation(data, { user: authorization }, !isAuthorizedNode)`, so a
   caller with an `hdb_nodes` row skips `verifyPerms`. Replicated `deploy_component` and
   `set_configuration` ride that same path (`replicateOperation` → `sendOperationToNode`). A node
   principal can therefore deploy a component that calls the per-node operations locally, and can
   reach the same effect without this relay.
2. **The relay adds checking, not reach.** The per-node operations were reachable by a node principal
   through the dispatcher bypass before harper-pro#862 added the relay. What the relay adds is the
   local re-validation above, which is strictly more checking than the direct call it replaced.
3. **An operator proof on this one operation would not narrow the boundary.** A node principal that
   wanted to mint a map could still do so through the route in (1). Narrowing what node principals may
   run on a peer is a separate change, tracked in harper-pro#976. When #976 narrows node-principal
   operations, `record_lock_transition` remains the one node-principal route to a peer's home map
   (`hdb_record_lock_homes` is `LOCAL_ONLY`), so re-assess an operator proof (#869) at that point.
4. **Nothing shipped is exposed by default.** `replication.recordLocks` is off by default and grants
   nothing until an operator stages and activates a generation.

Accepted on that basis, by the task owner's ruling on #822.

### Not in scope

A survey-only dry run (`plan: true`) is cheap — phase 1 is already factored as a pure decision over
the survey — but it changes the operation's contract and is not built.
Narrowing the outage to only the keys whose home moves remains the open lever on harper-pro#856.
`record_lock_propose_homes` stays the read-only helper that suggests a list. `homeMap()`, the
freshness barrier and the poison rules are untouched; nothing here runs on a lock path.

## The cluster default home map (harper-pro#1452)

**Invariant:** for every database at most one map is live cluster-wide, whether from its own row or
from the default, and a database's map changes only through a fenced transition, never because a node
switched sources.

- **Storage and precedence.** The default is the row `DEFAULT_HOMES_KEY` (`/default`, which no database
  name can be) in the same table, moved only by stage/activate (`record_lock_apply_homes { default:
true }` or the per-node operations with `default: true`). On a node, a database with a detaching row of
  its own (a ring, or a marker's floor; `detaches`) follows it; any other inherits the default
  (`resolveEffectiveRow`, `inheritedFrom`), so an audit-only fence row detaches nothing, and a default
  row with no ring is no default (`hasRing`). Inheritance is resolved when the cache is filled
  (`refreshCache`), never on the lock path. Rows are never deleted, so an own row wins for good.
- **Every node is surveyed.** A default apply refuses unless every node the initiator's `hdb_nodes`
  names, and the initiator, is in `quiesce` (`runApply`, `known`): a node left out could hold, or take
  after its survey, an own row for a database whose default homes would then inherit it, and both
  rings would agree. A fenced node counts, under the survey's majority anchor: every own row it took
  through `record_lock_apply_homes` was mirrored on the live members of the ring it took it under
  (the default-ring coverage rule), and those are surveyed.
- **Digest scope.** `digestFor` hashes a `default` tag first, so a node inheriting a database and a node
  serving it from its own row never agree, even on equal `(generation, homes)`.
- **One fenced transition moves every inheriting database.** Staging the default retracts all of them in
  one durable write. The stage then drains each one on its owner (`drainInheriting`), and the node
  proves only if every database's drain proves. The drain set is fixed under the default row lock once
  every thread acked the retraction (`defaultStageScope` after `notifyChanged`; a database registered
  earlier has an owner entry by the time a grant under the old default could exist): every database main has an owner entry for, or released one
  for within `DELEGATION_DRAIN_MS` (`ownedOrRecentlyReleased`), plus, after the node's first
  incarnation, every database this thread's catalog replicates (`replicatedDatabaseNames`), minus those
  with own rows. It is empty only when the node had no default ring before (`staged.fresh`) and is in
  its first incarnation, the fact core's cold-start waiver rests on. Owner-side quiesce builds
  coordinators first (`quiesceOwned`), which core dates from `coordinationStartedMono`; a database with
  no coordinator (no tables, none that replicate, or dropped) proves on the first incarnation or once
  this thread has coordinated it for a lease (`coordinatedForALease`), while core still reports grants
  its closed coordinators issued.
- **No first own row mid-transition.** While a node holds a staged default whose `homes` include it,
  `planStage` refuses a database's first row of its own there, so the drain set and the reported
  own-row list cannot change between that node's stage and its activation, retries included. A node the
  staged default leaves out never activates it, so it may take a first own row, planned against the
  rings that staged default remembers.
- **Own rows never coexist with an agreed inherited ring.** Inherited X is agreed only if every member of
  the live default ring inherits X. A per-database apply on an inheriting database plans against the
  effective row, so `planSurvey`'s unlisted check and the local `planStage` force `quiesce` to cover the
  default ring, and its generation is above the default's. A first own row is refused while this node
  already has `MAX_EXPLICIT_DATABASES` own rows, so a stage never meets an exclusion list it must refuse
  after retracting. A default activation writes a marker
  (`markerRows`) for every database any surveyed or staged node reported an own row for (the activate
  hop's `explicit`, required on a default activation, which the apply unions from every survey and
  stage reply's own rows and `staged.explicit`). The promotion records that list as `active.explicit`,
  so every home of a generation promotes the same exclusions: an activation refuses a staged name its
  list lacks, and a retry of an active one refuses unless it names every promoted name and every name it
  lists has a row here (a name beyond the promoted list took a row of its own since). Only a staged default is promoted, so no marked database holds inherited
  authority there; an already-active default writes no marker, since that would retract a live map
  without a drain, so an apply (or the fenced recovery it prints) that finds a home already active at
  the target without a name the union carries opens the next generation instead of resuming. `resolveEffectiveRow` reads a database's own row again after the default, so a
  refresh never pairs a pre-marker absence with the default the marker preceded.
- **Rows planned under the default lock commit under its lease.** A database without a detaching row is
  planned under the default row's lock only (`withEffectiveRow`, which `record_lock_fence_external` also
  takes), and every writer that creates such a row holds that lock, so its presence is stable there.
  The new row, and every marker, commits in one transaction with a write through the default row's
  held lock (`writeRows`; a ring-less placeholder when no default row exists), and core's pre-submit
  fence refuses the whole transaction once that lease lapsed. A child row committed through its own
  lock could land after another worker moved the default; an off-key write through the locked resource
  is dropped, not fenced. A database with a detaching row takes only its own lock (default → database
  is the only nesting order).
- **Clone lineage.** A row created while a default row exists takes the default's `cloneAttempt`, so a
  re-clone still marks the database ever-recloned (`markReclonedIfLockHistory` reads the effective row).
- **Fan-out.** A default write sends one acked notice per thread; each thread re-reads every registered
  database's own row (`applyHomesChanged`) under a larger ack budget and acks false if any read failed,
  and `refreshCache` re-announces whenever a cached digest changes, which a database created at runtime
  needs.

Why no two maps for a database can be live, by case:

1. **Two live defaults.** The default row follows §4.3 exactly, including the fenced majority anchor,
   so the per-database argument carries over.
2. **Own row vs. inherited.** The bullet above. A stage that lands on a node before its default stage is
   in that stage's own-row list; one that lands after is refused unless it covers the staged default's
   `quiesce`, so its apply stages every new member. While such an apply is still landing, its own map
   is only staged, so the inherited map is the only live one, and the database's own stage drains it.
3. **A node joining mid-flight** has no default row until an apply names it, so it inherits nothing; the
   apply that adds it stages the whole new ring before any node activates. `system` tables do not
   replicate, so a clone copies no default.
4. **Two members with different defaults** is case 1: it needs an activation that skipped a live member
   of the earlier ring, which the survey refuses.
5. **The relay-only case (harper-pro#1313)** needs a node to create a first map. Here only an apply
   creates one, and agreement needs a direct digest frame on each database's own socket between every
   pair of ring members, so a relay confers nothing. A default applied on a subset of the nodes is
   refused by the survey rule above; a node missing from the initiator's own `hdb_nodes` view
   (membership lag) remains the operator error a per-database apply has.

A database not replicated by every default-ring member never agrees under the default (503, never two
maps) and needs a map of its own. The per-node operations stay sharp tools: a leaver can still activate
a singleton own map, as it can on a per-database leaver.
