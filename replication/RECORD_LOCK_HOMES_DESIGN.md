# Cluster record locks: the operator-agreed home map (harper-pro#825, inside #822)

Design note for the harper-pro half of `docs/record-lock-ownership.md` §4, now that
harper#2498 has merged with that section's round-7 revision: the durable membership-epoch
consensus protocol harper-pro#825 originally scoped is **deleted, not deferred** — replaced
by an operator-published, digest-agreed, immutable-per-generation home map. Core's interface
changed accordingly: `ClusterLockTransport.epoch(): LockEpoch | undefined` is gone; core now
requires `homeMap(database): LockHomeMap | undefined` where `LockHomeMap = { generation,
homes[], homeIncarnation }` (`core/resources/recordLockCoordinator.ts:103-224`).

Per the merged design note §14 (lines 886-887), what remains of #825 after the round-7
adoption is exactly three things: a `recordLockHomes` generation record, a peer digest check,
and the §4.3 change runbook (stage → quiesce/fence → drain → activate). This note covers the
harper-pro-side mechanism for all three, plus `homeIncarnation` advanced per **coordination
incarnation** (§5.1), the one other item genuinely part of the same `homeMap()` contract.

**Out of scope here, deliberately** (the task owner's instruction was specifically "825," not the
rest of §11's "still owed" list): the `lockRelease` cross-thread relay gap and full
every-serving-thread transport registration. Real, blocking for _enablement_, and called out
as findings — not folded in here. harper#2542's freshness fence, the third item on that list,
landed afterwards on this same PR — see `RECORD_LOCK_FRESHNESS_DESIGN.md`.

**Revision history — two rounds, both `better-alternative-exists`, both adopted.**

- **Round 1** (`8f2f03890502`): rejected a "trusted orchestrator collects incarnation-bound
  acknowledgements into one canonical activation artifact" design's first cut on four
  blockers (local-only evidence can't support a cross-node check; "acknowledge" observed
  state without establishing quiescence; incarnation-bump ordering; storage atomicity) plus
  several significant findings (hot-path cost, weak digest, handshake refresh, auth/replay).
  I responded by **over-correcting**: replacing cross-node evidence collection with a purely
  local per-node wall-clock timer — which round 2 then showed does not actually establish
  the invariant.
- **Round 2** (`cb288f1e9a0a`): rejected the local-timer design on four new blockers, each
  with a concrete two-holder counterexample — staging didn't quiesce the old generation
  immediately, so a `g` grant could still be issued right up to the drain deadline; per-node
  receipt deadlines are not a last-node barrier under staggered delivery; `Date.now()` is not
  a safe elapsed-time proof across a restart or clock correction; the incarnation fix was
  attached to one caller, not the ownership-assignment invariant. Its framing section states
  the resolution directly: **"A concretely better online approach is durable quiescence on
  stage plus a separate operator-issued activation record after the last stage/fence and
  drain."** — i.e., round 1's original shape, correctly.

**This is round 3 of the note, not a third planning round of review.** Round 2's fixes are
adopted here on the facts — each is a concrete, verifiable counterexample, not a judgment call
— converging on almost exactly round 1's original suggestion. Per
[design-alternatives.md](../../../.claude-devagent/skills/harper-engineering-guidelines/rules/design-alternatives.md),
adopting a reviewed alternative does not require a further round "unless the switch opens a
new question"; this one does not — it is the union of both rounds' own explicit
recommendations, not a new mechanism. Both rounds' rejections of the "different layer" and
"deeper cause" axes stand unchanged throughout; only "do less" and "chosen" moved, and they
converge to the same place: an **operator-timed**, not **node-timed**, transition.

## What this branch has wrong today

`replication/recordLockTransport.ts`'s `epoch()` derives `LockEpoch{number: 1, members,
ringVersion}` **locally, from live `hdb_nodes` + capability advertisement**, on every node,
independently — exactly the shape core's design doc now says must not exist. It cannot compile
against `homeMap()` at all, and has the two-holder hole the PR's own `## For the human
reviewer` section already disclosed.

`homeIncarnation` is bumped once at process start and pushed to every worker; §5.1 requires it
to advance once per **coordination incarnation** (a process start _or_ a coordinating-worker
restart), which today's single call site at process start does not do.

## The invariant this change enforces

**At most one generation is ever live, cluster-wide, for a given database's home map. Before
any node exposes generation `g+1` via `homeMap()`, every node capable of granting or honoring
`g` must have durably stopped doing so — immediately, not after a delay measured from an event
only that node observed — and the wait for any surviving authority to expire must be measured
from the _last_ such stop across the whole affected set, by a single external, trusted
timekeeper, not reconstructed independently by each node from its own clock.**

## Approaches considered

**Root cause:** the home map is currently _derived_ (computed independently by each node from
data that can disagree), when core's contract requires it to be _stated_ (published once,
identically, and verified to be identical before use) — and, per round 2, the _transition_
between two states of that fact must be governed by the same discipline: stated and externally
timed, not independently inferred by each participant.

| Axis                | Candidate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Why not chosen / why chosen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Different layer** | Move home-map ownership into core.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Disqualified by core's own docstring and design-doc §4 ("harper-pro owns this, because it owns topology"). Confirmed closed by both round 1 and round 2.                                                                                                                                                                                                                                                                                                                                                                         |
| **Deeper cause**    | Rebuild automatic, consensus-derived rehoming.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Already rejected upstream at the core-design level (design-doc §9, §14 round 7), with a recorded disqualifier. Confirmed closed by both rounds.                                                                                                                                                                                                                                                                                                                                                                                  |
| **Do less**         | (a) Global hot-reloadable config, no digest, no staged transition — disqualified round 1: skips §4.3 entirely. (b) A purely local per-node timer with no cross-node evidence — **tried, disqualified round 2**: staggered delivery and non-immediate quiescence reopen the two-holder bug; a per-node clock cannot prove a cluster-wide elapsed-time fact. (c) Full affected-cluster stop/fence/wait/publish/restart, no online mechanism at all — **valid per round 2's framing section**, but costs full unavailability of every affected node for the drain window on every reconfiguration, not only the keys that moved. | (c) remains available as a documented manual fallback (an operator can always choose to stop every node instead of using `stage`) but is not the implementation: the online design below achieves the same safety without mandating a full-cluster outage, at the cost given up in "the cost of this design," below.                                                                                                                                                                                                             |
| **Chosen**          | Durable per-database `{active, staged}` state, where **staging immediately and durably retracts `active`** (real quiescence, not observed-then-inferred); a **separate, explicit, operator-issued `activate`** call, timed by the operator's own external wall-clock wait from the _last_ stage/fence event across the whole affected set — not by any node's local clock; digest mismatch makes the whole map unavailable, not a shrunk ring.                                                                                                                                                                                | Directly implements round 2's framing-section recommendation. Removes every counterexample both rounds raised: quiescence is immediate and durable (round 2 blocker #1); the drain wait is anchored externally, by the operator, from the true last event, not reconstructed per node (round 2 blocker #2); no node's `Date.now()` is safety-load-bearing (round 2 blocker #3); a digest mismatch fails the whole map closed rather than admitting a shrunk, still-live ring (round 2 finding under "Security and correctness"). |

## The cost of this design, stated plainly

**A database's cluster record locks are fully unavailable, on every staged node, from the
moment `stage` is durably received until the operator issues `activate`** — not narrowed to
the keys whose home is moving. This is a real, direct consequence of "staging immediately
retracts `active`," and it is more availability cost than round 1's first draft implied and
more than the merged core design doc's own prose suggests is necessary (it describes
quiescing only the nodes losing a key's ownership, implicitly). It is accepted here because
round 2 demonstrated that anything less either reopens the two-holder bug (a local timer) or
requires infrastructure this note is not scoped to build (a canonical, cross-node-synchronized
partial-quiesce protocol). The operator controls the window's length by controlling how
promptly they call `activate` after the drain elapses — there is no reason to delay it beyond
that — so in practice the cost is bounded by `DELEGATION_LEASE_MS + skew` (the drain interval)
plus operator latency, not by anything unbounded.

## Design

### 1. Durable storage — a dedicated local-only table, atomic per database

A new system table, `hdb_record_lock_homes`, one row per `database`, `LOCAL_ONLY` (defined via
the same `table({ table: '…', database: 'system', attributes: […] })` helper `hdb_nodes` uses,
`replication/knownNodes.ts:50-60`; written via the same low-level `_writeUpdate(…, false, {
localOnly: true })` primitive `ensureNode` already uses — never replicated, never LWW-merged):

```ts
interface RecordLockHomesRow {
	database: string; // primary key
	active?: { generation: number; homes: string[]; digest: string };
	staged?: { generation: number; homes: string[]; digest: string };
	highestActedOn: number; // monotonic floor: max(active?.generation, staged?.generation, highestActedOn), updated atomically with every write, never only on promotion (round 2 finding — a delayed stale `stage` must not clobber a newer `staged`)
	fenced: { node: string; operator: string; at: number }[]; // audit only; no grant path reads it
}
```

Every write is a compare-and-set against the row's current state, in one transaction — not a
read-then-patch of a shared blob.

### 2. The operations API

Three mutating operations, `replication/recordLockHomes.ts`, `super_user`-gated, Joi-validated,
mirroring `setNode.ts`'s shape. `operator` on every audit-bearing field is derived from the
authenticated principal (`request.hdb_user.name`), never a request-body field — a forgeable
attribution was a round-2 finding.

- **`record_lock_stage_generation`** `{ database, generation, homes[], quiesce[] }` — issued by the
  operator on every node named in `homes(g) ∪ homes(g+1)`, which is what `quiesce` names (required
  since harper-pro#862: it is persisted on the staged row, and a matching re-stage backfills it on a
  row that lacks one). Canonicalizes `homes[]` (sort,
  dedup) before storing or hashing. Refuses `generation ≤ max(active?.generation ?? 0,
staged?.generation ?? 0, highestActedOn)`. On success, **atomically**: computes `digest`
  (below), writes `staged = { generation, homes, digest }`, and **clears `active`** — the
  durable write that makes this node stop granting under the old generation is the same write
  that records the new one is staged, so there is no window between "told about g+1" and
  "stopped granting under g." The HTTP response, once returned, is real quiescence evidence
  (round 2: "a successful stage response is then real quiescence evidence"). Idempotent:
  identical `(generation, homes)` re-issued is a no-op success; a different `homes[]` for a
  `generation` already staged is rejected.
- **`record_lock_fence_external`** `{ database, node }` — the operator's durable, audit-only
  attestation that an unreachable node has been stopped outside Harper. Appended to `fenced[]`
  on whichever node the operator is talking to. Consulted by no grant path — its safety is the
  operator's own action (the node is stopped), not anything Harper verifies.
- **`record_lock_activate_generation`** `{ database, generation, homes[] }` — issued by the
  operator, once, on every node in `homes(g+1)` (idempotent replay across nodes and across
  retries), **only after** the operator has, externally, in their own wall time: collected a
  successful `stage` (or `fence_external`) response from every node in `homes(g) ∪ homes(g+1)`
  — the whole `quiesce` set, which is wider than the set being activated — and then waited
  `DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS` from the _last_ such
  response. Refuses unless `staged` on this node matches `(generation, homes)` exactly
  (replay/consistency check — a stale or misdirected activate for the wrong transition is
  rejected, not silently applied). On success, atomically promotes `staged → active`, clears
  `staged`, updates `highestActedOn`. **No node measures the drain wait itself** — round 2:
  "cannot be proven by subtracting persisted wall times." The wait is the operator's
  externally-observed fact; nodes only ever check _consistency_ (does this match what I
  staged?), never _elapsed time_.

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

### 3. `homeMap()` — a frozen pointer read, no hot-path cost

Per thread, cache one frozen `LockHomeMap | undefined` per database, updated **only** when this
node's own `active` row changes locally (on `stage` clearing it, or `activate` setting it) —
never derived, hashed, sorted, or read from storage inside `homeMap()` itself. With
`replication.recordLocks` off, no table watcher or cache exists at all (round 2: preserve the
existing disabled-transport selection unchanged).

### 4. Digest mismatch fails the whole map closed, not a shrunk ring

**Round 2's sharpest correctness finding**: excluding a disagreeing peer from _this_ node's own
ring (what the round-1 draft did) does not prevent two arbiters — with `homes = {A,B}`, a
digest disagreement makes A derive ring `{A}` and B derive ring `{B}`, and both self-home every
key. **Fix:** a digest mismatch with _any_ peer named in the active `homes[]` makes `homeMap()`
return `undefined` for the whole database on the observing node — core's own existing "fails
closed when no map is available" behavior, not a locally-recomputed smaller ring. This also
simplifies the mechanism: there is no ring recomputation at all, only "available" or "not."

### 5. Canonical digest encoding

Length-prefixed, not delimiter-joined (round 2: `['A','B']` and `['A\0B']` must not collide).
`sha256(u32be(generation) ‖ u32be(homes.length) ‖ Σ(u32be(len(home_i)) ‖ utf8(home_i)))` over
the canonicalized (sorted, deduped) list. Validated on write: `generation` a positive safe
integer; `homes` non-empty, bounded count, each name non-empty and bounded length.

### 6. Wire: a dedicated digest message, not a `NODE_NAME` resend

Round 2: reusing `NODE_NAME` as a live refresh is unproven — its handler has side effects
(`sendSubscriptionRequestUpdate()`, `replicationConnection.ts:4524-4603`). **Fix:** a new,
minimal message type, `RECORD_LOCK_HOMES_DIGEST` (`{ database, digest }`), sent (a) once at
initial handshake per database, alongside/replacing the capability bag's role for this data,
and (b) standalone, on every live outbound connection for a database whose local `active`
digest just changed (on `activate`) — with no other handshake side effect triggered. Receipt
writes only a tri-state match/mismatch/unknown result into the per-(database,peer) shared
status buffer (slot 30, after the existing capability-level slot 29) — the full digest itself
travels on the wire, compared byte-exact on the socket thread, never truncated into shared
memory.

### 7. `homeIncarnation` per coordination incarnation, gated centrally

Round 2: the round-1 fix (await the bump inside `watchOwnerExit` before reassigning) missed a
second path — `subscriptionManager.ts:760-763`'s `placeSubscription` also calls
`recordLockOwnerFor` directly. **Fix, moved into `recordLockOwnerFor` itself** (the single
function every ownership-assignment path already funnels through) rather than patched at each
caller: on a genuine handoff (a new owner differing from a previously-live one for that
database), `recordLockOwnerFor` durably awaits `bumpHomeIncarnation()` before conferring live
ownership; while the bump is in flight, the database is reported **unowned** to every caller
(`ownsRecordLockCoordination` returns false), never assigned under a stale incarnation. A
persistence failure leaves it unowned rather than retrying into a race. Concurrent
reassignments across databases are serialized behind one in-flight-bump guard so the
read-increment-write in `bumpHomeIncarnation` cannot race itself.

### 8. Wire/capability version bump

`RECORD_LOCKS_CAPABILITY` moves 2 → 3: the wire shape changes (`epoch` → `generation`; the new
digest message), and per the merged design doc's mutual-exclusion rule, levels are versioned
even though level 2 never shipped enabled.

### 9. Error containment

Every promotion write, socket announce, and worker-message/exit handler is wrapped so a
rejection cannot become an unhandled rejection on the main or a worker thread — persist first,
publish the local cache pointer only after persistence succeeds, and fail closed (leave the old
pointer or `undefined`) on any error in between; mirrors the existing containment pattern at
`recordLockTransport.ts:454-472,617-621` rather than inventing a new one.

## Testing

- Unit: canonical-encoding determinism (including the `['A','B']` vs `['A\0B']` non-collision);
  `highestActedOn` refusing a delayed stale `stage` after a newer one (compared against
  `max(active, staged, highestActedOn)`, not only post-promotion); `stage` atomically clearing
  `active` in the same transaction (no window where both are set); `activate` refusing a
  mismatched `(generation, homes)`; digest mismatch producing `undefined` for the whole
  database, not a smaller `homes[]`; `recordLockOwnerFor` reporting unowned while a bump is in
  flight, from both call sites; bump-failure leaving coordination unowned.
- Integration (`recordLockCluster.test.mjs`, "the §4.3 stage/activate transition" suite, as
  actually landed — a real pre-push review finding: this section previously described a larger
  integration surface than the branch shipped): no active generation fails every cluster lock
  closed; staging retracts any active generation immediately, with no window where a lock
  succeeds mid-transition; activation is idempotent and refuses a generation that does not match
  what is staged. Not yet covered at integration level, and worth adding: digest mismatch across
  real nodes (the unit suite covers the pure decision, not the wire); `record_lock_fence_external`
  (zero coverage, unit or integration); a coordinating-worker or process restart exercising the
  incarnation-ordering fix under real IPC; a persistence failure injected mid-bump.

## For the human reviewer (carried into the PR)

- **Two consecutive planning rounds rejected earlier framings of the §4.3 mechanism** —
  summarized above under "Revision history." This design is the point both rounds converged
  on; flagging that history rather than presenting it as settled from the start.
- **The full-database availability cost while staged** (not narrowed to moved keys) is a real,
  stated tradeoff — see "The cost of this design" — worth a second look given it is more
  conservative than the core design doc's own prose implies is strictly necessary.
- Genuinely deferred, not silently dropped: the `lockRelease` cross-thread relay gap and full
  every-thread transport registration — named in the merged design doc's §11 "still owed" list
  but outside #825's redefined scope per the task owner's instruction.
- **`grantableAfterMono` needs three independent recreate triggers, not one.** Core's own
  coordinator (`#ownershipHorizon`, `recordLockCoordinator.ts`) keeps the restart-quarantine
  waiver only if the coordinator was built already owning coordination _and_ already able to
  read a real `homeMap()` — both facts this transport learns asynchronously, and core builds
  its coordinator lazily off any `TableResource.lockCoordinator` access, including
  `cluster_status` polling. `recordLockTransport.ts` now recreates the transport object (which
  forces a fresh coordinator on next access) on each of: this node's own first-incarnation
  status becoming known, ownership newly conferred, and the active generation newly becoming
  available. Each is independently necessary — found by hitting the "restarted and cannot
  grant" 503 after only the first two, then reading core's current source directly rather than
  the interim snapshot this design was drafted against.
- **Integration verification is honest but incomplete**, for a reason outside this PR: a full,
  single, clean run of all 11 `recordLockCluster.test.mjs` tests together, on the current
  pushed code, was not obtained — every attempt after the third fix above was blocked by two
  confirmed pre-existing, external causes on the machine this ran on (this session's own
  processes being OOM-killed by the harness, and `@harperfast/integration-testing`'s shared
  loopback-address pool file being corrupted by a non-atomic write raced with another
  concurrent process). What _is_ confirmed: unit tests fully green throughout every change; a
  partial run, after the third fix, passing all 4 real tests in the hardest suite (three-node
  mesh, including 24-way concurrent contention) before being killed moving into suite 2. Re-run
  the suite once outside a contended shared box before relying on it as a clean pass.

## Assembling a home map: `record_lock_propose_homes`

Added on the task owner's request (2026-09-16), after the planning review **rejected the operation
originally proposed** — a `record_lock_bootstrap_generation` that would derive `homes` from
`hdb_nodes` and write `active` for generation 1 directly, skipping stage/drain/activate on the
grounds that the node had never had a home map. Both halves of that were wrong, and both are easy
to re-propose, so the counterexamples are recorded here rather than only in a review artifact.

### Why deriving per node cannot be made safe by the digest check

The rejected design rested on "if two nodes derive different sets their digests differ, so
`homeMap()` is withheld on both." That is false. `homeMap()` iterates its **own** `active.homes`
(`recordLockTransport.ts`), so a node whose derived set is `[A]` has no peers to check, skips the
loop entirely, and serves its ring immediately. A and B with disjoint or merely incomplete views
each get a usable map and both arbitrate the same key. **A digest cannot detect a participant
omitted from the set being digested** — which is exactly what §4.1 means by stated rather than
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
active and staged rings — and it is returned as a field rather than described in prose because the
first draft of this operation got it wrong in a way worth recording: its warning said to stage "on
every node named in [`homes`]", which on a **shrink** omits the node being removed. That node is
never staged, keeps its old active generation, and keeps granting while the new ring grants too —
two arbiters, produced by following the operation's own advice. A departing node must still be
staged or `record_lock_fence_external`'d and drained; `quiesce` names exactly that set, and a
warning names the leaving nodes explicitly.

Two further limits are stated in the response rather than left for an operator to discover, both
raised in review against the first cut:

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
unchanged. The returned digest is what lets a
script confirm every node agrees before it activates. Because it is a read, none of the blockers
above apply to it — a suggestion that is wrong costs an operator a re-run, not two arbiters.

The generation it returns is one past this node's own floor, so the same operation serves a
topology change as well as a first bootstrap. It is still only this node's view; agreement remains
the operator's act.

### Approaches considered

| Axis                | Candidate                                                                                                                        | Ruling                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Different layer** | Derive the ring inside `homeMap()` when no row exists, so nothing has to be called.                                              | Rejected — §4.1's two-arbiter bug, and now with a concrete mechanism: the agreement loop cannot see a node it was never told about.                                                                                                         |
| **Deeper cause**    | A mutating bootstrap that writes `active` for generation 1 behind a fresh-state guard.                                           | Rejected in planning review on the two counterexamples above. Making it safe would require asking every derived peer whether it already has authority and failing closed on any unreachable one — single-decree agreement, deleted by #825. |
| **Deeper cause**    | One orchestrating call that fans stage → wait → activate out to every node.                                                      | Deferred — needs credential delegation for a `requiresSuperUser` operation across nodes plus partial-failure semantics, and would be the same shape for every generation, not just the first. Tracked with the default-on work.             |
| **Do less**         | Document a script that reads `cluster_status` on each node and assembles the list.                                               | Close, and what an operator can do today; the operation adds canonicalization, the digest, the current state and the bounds validation in one authenticated call, with no new authority.                                                    |
| **Chosen**          | A read-only proposal: derive, canonicalize, hash, report — the operator still stages and activates the returned list everywhere. | Removes the typing, which was the actual ask, while leaving every authority-bearing step exactly where §4.3 already put it.                                                                                                                 |

## Applying a home map across the cluster: `record_lock_apply_homes` (harper-pro#862)

`record_lock_propose_homes` removed assembling the list by hand; it did not remove the N×2 loop of
`record_lock_stage_generation` on every node in `homes(g) ∪ homes(g+1)` followed by
`record_lock_activate_generation` on every node in `homes(g+1)`, with the operator carrying one
identical list to each and deciding when the drain is done. This section adds the single
operator-facing call that drives that §4.3 transition, **given an explicitly supplied list of
expected nodes**. Everything the two rejections above established still holds: the list is stated,
never derived, and this operation orchestrates without ever authorizing policy.

**Revision history.** The planning review of the first draft returned `better-alternative-exists`,
proposing a "manifest-backed transition" — persist `{generation, digest, homes, quiesce,
transitionId}` on stage, return a receipt with a relative wait, and refuse an attested retry that
stages any new participant. Adopted in part, on four concrete counterexamples against the draft
(each recorded where the design now closes it): the attestation covering a node the same call had
just staged; a retry with a defaulted `quiesce` losing the old ring once staging had erased `active`;
an absolute `activateAfter` assembled from peers' clocks; and immediate activation running into the
per-node 2 s backstop. Overruled: the `transitionId` and receipt. `(generation, digest)` already
identifies a transition exactly — `planStage` refuses a different set at a staged generation and
`planActivate` refuses anything but the exact staged pair — so a second identity would be one the
planners do not check; the one field the row genuinely lacked is `quiesce`, and that is what is now
persisted. The reviewer's self-hop objection was already met in code (the initiating node dispatches
to itself locally; the note now says so).

### The invariant this change enforces

**No node stages or activates a generation this call did not verify against every node the operator
named, and no node activates `g+1` while any node in `homes(g) ∪ homes(g+1)` is unreachable, has not
staged it, or has neither proven quiescence nor been covered by an operator-attested drain wait that
began after that node was staged.** The failure direction of every partial outcome is refusal: a
half-applied call leaves some nodes quiesced (their cluster locks 503) and none double-granting.

### Why the explicit list is what makes orchestration safe

The rejected bootstrap derived the ring per node, and the digest check cannot save that: `homeMap()`
iterates its own `active.homes`, so a node whose derived set is `[A]` checks no peers and serves its
ring immediately — a digest cannot detect a participant omitted from the set being digested. When the
operator states the set there is nothing to omit, so "ask every named node, refuse if any does not
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

| Condition                                                                                                                               | Why it refuses                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any named node does not answer, or answers under a different name                                                                       | completeness is the point of the list; a misrouted `hdb_nodes` URL is an unanswered node. A peer too old to have `record_lock_transition` fails here, before any stage                                                                                                                                                                                                             |
| any node reports a ring member not in `quiesce` — in `active.homes`, `staged.homes`, or the `quiesce` its `staged` row was written with | "you forgot a node that is still granting" — the residue of the second #822 objection. Staging retracts `active`, so a staged node's row no longer names the old ring; the `quiesce` persisted on stage (the adopted review point) is what still does, which is what makes a retry with a shorter list refusable                                                                   |
| a surveyed `staged` row has no recorded `quiesce`                                                                                       | it was staged by a stage that did not name its participants (a row from before this change), so the ring it stopped serving cannot be checked against the list; the operator re-stages the same generation and set with `quiesce` on that node, which backfills it                                                                                                                 |
| nodes disagree about `active` (two distinct `(generation, digest)`)                                                                     | two rings are being served; §4's whole-map-fails-closed rule already withholds locks on such nodes. A disagreement about `staged` is not refused here: it is judged by the next row, so an explicit higher generation supersedes two sets that two racing operators staged (otherwise the cluster would stay quiesced until someone used the per-node operations — a review point) |
| `planStage` would reject the target on a node that is not already active at it                                                          | a staged different set for the same generation, or a generation below that node's floor; the same pure decision the per-node operation makes, run as a dry run                                                                                                                                                                                                                     |

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
node's own stage — a review point) and activates `homes`. Otherwise it does **not** activate: it returns
`outcome: 'staged'`, the per-node drain results, and `retryAfterMs` — the drain interval, to be measured
by the operator from receiving the response and never assembled from node clocks (a review point: an
absolute time from a node whose clock is behind is already past). The second call carries the reported
`generation` and `drained: true`. It re-surveys, re-stages (noops that drain again), and then activates
whether or not the drain proves — **but only for nodes that were already staged at the target when
this call surveyed them.** A node this call had to stage has had no interval at all, so the attestation
cannot cover it (the reviewer's counterexample: A and B staged, C's stage failed, the wait passes, the
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

One fact found while tracing this, worth recording because it changes what the gate is _for_:
`replicationConnection.ts` dispatches an inbound operation as `server.operation(data, { user },
!isAuthorizedNode)`, and a caller with an `hdb_nodes` row bypasses `verifyPerms` entirely — so a node
principal could already invoke the `requiresSuperUser` per-node operations over the wire. The
peer-callable operation is therefore not what lets a peer write; it is what keeps a `super_user` HTTP
caller from driving the relay under a node's name (`principalNodeName` refuses anyone not in
`server.nodes`), and its local re-validation is what keeps a peer from pushing a set this node did not
verify. A departed-but-still-known node principal keeps that pre-existing authority; this operation
neither widens nor narrows it, and the dispatcher's node-wide bypass is reported as a finding rather
than changed here.

### Approaches considered

| Axis                       | Candidate                                                                                                                                                                                                                                                                                                                         | Ruling                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Different layer**        | Orchestrate outside Harper: a script or CLI that authenticates to every node and drives the per-node operations, with a read-only survey added.                                                                                                                                                                                   | Valid as a manual fallback, and the per-node operations stay for exactly that. Not chosen because it cannot express "unreachable is a hard failure" for a node the script's credentials cannot reach, cannot persist the participant set anywhere the survey can find it again, and carries the operator's secret to N nodes per call. |
| **Deeper cause**           | Derive the set (from `hdb_nodes`, or by agreement), so no list is needed.                                                                                                                                                                                                                                                         | Rejected twice already, above, with the mechanism recorded: a digest cannot detect an omitted participant, and no local state proves the absence of prior authority. Not reopened.                                                                                                                                                     |
| **Do less**                | Forward the operator's credentials per hop and reuse the existing `requiresSuperUser` operations unchanged.                                                                                                                                                                                                                       | Rejected: the operator's secret in flight to N peers per call is a new exposure for no gain, and — the fact above — the hop is authenticated as a node principal anyway, so what actually has to exist is the receiving node's own re-validation, not a forwarded permission.                                                          |
| **Do less**                | Stage-and-activate in one call with a fixed wait, no drain evidence.                                                                                                                                                                                                                                                              | Rejected: holds an HTTP request for ~6 minutes, and the drain (#856/#861) already exists to make that wait unnecessary in the planned case.                                                                                                                                                                                            |
| **Reviewer's alternative** | A manifest-backed transition: persist `{generation, digest, homes, quiesce, transitionId}`, return a receipt, refuse an attested retry that staged anything new.                                                                                                                                                                  | Adopted except the identifier (see the revision history): `quiesce` is persisted on the staged row, the wait is relative, the attestation covers only nodes already staged at survey. A `transitionId` would be a second identity `planStage`/`planActivate` never check; `(generation, digest)` is already exact.                     |
| **Chosen**                 | One `super_user` call: survey → refuse on any incompleteness → stage everywhere (persisting `quiesce`) → activate immediately on proof, else report a relative wait and let an attested second call finish what was already staged. A node-principal peer operation that re-validates, including its own place in the transition. | The only shape that makes "unreachable is a hard failure" expressible while keeping every authority-bearing decision on the node that owns the row.                                                                                                                                                                                    |

### Not in scope

A survey-only dry run (`plan: true`) is cheap — phase 1 is already factored as a pure decision over
the survey — but it changes the operation's contract and is left for the task owner to rule on.
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
