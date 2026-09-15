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

- **`record_lock_stage_generation`** `{ database, generation, homes[] }` — issued by the
  operator on every node named in `homes(g) ∪ homes(g+1)`. Canonicalizes `homes[]` (sort,
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
  operator, once, on every node named in `homes(g) ∪ homes(g+1)` (idempotent replay across
  nodes and across retries), **only after** the operator has, externally, in their own wall
  time: collected a successful `stage` (or `fence_external`) response from every node in that
  set, and then waited `DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS` from the _last_ such
  response. Refuses unless `staged` on this node matches `(generation, homes)` exactly
  (replay/consistency check — a stale or misdirected activate for the wrong transition is
  rejected, not silently applied). On success, atomically promotes `staged → active`, clears
  `staged`, updates `highestActedOn`. **No node measures the drain wait itself** — round 2:
  "cannot be proven by subtracting persisted wall times." The wait is the operator's
  externally-observed fact; nodes only ever check _consistency_ (does this match what I
  staged?), never _elapsed time_.

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
