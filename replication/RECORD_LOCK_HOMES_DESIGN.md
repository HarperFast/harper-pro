# Cluster record locks: the operator-agreed home map (harper-pro#825, inside #822)

Design note for the harper-pro half of `docs/record-lock-ownership.md` §4, now that
harper#2498 has merged with that section's round-7 revision: the durable membership-epoch
consensus protocol harper-pro#825 originally scoped is **deleted, not deferred** — replaced
by an operator-published, digest-agreed, immutable-per-generation home map. Core's interface
changed accordingly: `ClusterLockTransport.epoch(): LockEpoch | undefined` is gone; core now
requires `homeMap(database): LockHomeMap | undefined` where `LockHomeMap = { generation,
homes[], homeIncarnation }` (`core/resources/recordLockCoordinator.ts:103-224`).

Per the merged design note §14 (lines 886-887), what remains of #825 after the round-7
adoption is exactly three things: **a `recordLockHomes` generation record, a peer digest
check, and the §4.3 change runbook** (stage → quiesce/fence → drain → activate). This note
covers the harper-pro-side mechanism for all three, plus the one other `homeMap()`-contract
item that is genuinely part of the same interface: `homeIncarnation` advanced per
**coordination incarnation** (§5.1), not only per process start, which the current branch
gets wrong (see "What this branch has wrong" below).

**Out of scope, deliberately** (per the task-owner's instruction, "implementing 825 inside of
822" — not #2542 or the other still-owed items §11 lists alongside #825): §7's freshness
fence / dependency-set work (harper#2542), the `lockRelease` cross-thread relay gap, and
registering the transport on every worker thread. Those are real, listed in §11's "still owed"
set, and blocking for *enablement*, but they are separate issues from #825's redefined scope
and are called out as findings rather than folded in here.

## What this branch has wrong today

`replication/recordLockTransport.ts`'s `epoch()` derives `LockEpoch{number: 1, members,
ringVersion}` **locally, from live `hdb_nodes` + capability advertisement**, on every node,
independently — exactly the shape core's design doc now says must not exist: "no node ever
derives, proposes or advances one from what it observes" (§4). It cannot compile against
`homeMap()` at all (no `epoch`/`LockEpoch` export left in core), and even if it could, it
still has the two-holder hole the PR's own `## For the human reviewer` section already
disclosed: two nodes can derive different membership during a live topology change, because
nothing is agreed — each side is simply confident in its own view.

`homeIncarnation` is bumped once at process start (`bumpHomeIncarnation`, called from
`whenThreadsStarted`) and pushed to every worker. §5.1 requires it to advance once per
**coordination incarnation** — "a process start _or_ a coordinating-worker restart" — because
coordinator state, the delegation counter included, is per-thread: today, if the owning HTTP
worker exits and `recordLockOwnerFor` reassigns coordination to a fresh worker
(`recordLockTransport.ts:476-491`, `watchOwnerExit`), the replacement gets the *same*
`homeIncarnation` value over the `record-lock-incarnation` message, because main's in-memory
counter never bumped. The replacement worker's delegation counter restarts at zero under an
unchanged `homeIncarnation`, so it can re-mint a token identical to one its predecessor already
issued — exactly the ordering hole §5.1 names.

## The invariant this change enforces

**A node may answer `homeMap()` with generation `g` only if every node named in `homes(g)`
either already holds `g` or has been safely excluded from the transition (`) so at most one
generation is ever live for a given key at a time** — i.e., the two-holder scenario §4.2's
counterexample and §4.3's "why step 2 is not optional" walk through must be unreachable by
construction, not by hoping every node's local view happens to agree.

## Approaches considered

**Root cause:** the transport's home map is currently *derived* (computed independently by
each node from data that can disagree — live membership, timing), when core's contract now
requires it to be *stated* (published once, identically, and verified to be identical before
use).

| Axis | Candidate | Why not chosen / why chosen |
|---|---|---|
| **Different layer** | Move home-map ownership into core, alongside the coordinator. | Disqualified by core's own docstring: `homeMap()` is "supplied by harper-pro; core never computes it and never advances it" (`recordLockCoordinator.ts:105`), and design-doc §4 states plainly "harper-pro owns this, because it owns topology." Core deliberately runs no election of its own at any rate (§9 "Chosen" row) — moving this in would reintroduce exactly the consensus subsystem round 7 removed. |
| **Deeper cause** | Re-derive membership automatically and safely (i.e., rebuild the durable-consensus epoch protocol #825 originally specified) so an unreachable node is rehomed without an operator action. | Already tried and rejected upstream, not by me: design-doc §9's "Do more" row and §14's round-7 ruling reject exactly this, with a recorded disqualifier ("a durable consensus subsystem... unpaid complexity," with the round-2 counterexample proving no timing argument substitutes for persisted acceptor state). Re-opening it here would relitigate a decision made at the core-design level that harper-pro's implementation does not get to second-guess without a new core-side change. Not proposed. |
| **Do less** | Treat the map as a global hot-reloadable config value (`replication.recordLockHomes`, like `replication.recordLocks`), read once by each node from its own config file — no digest exchange, no staged transition; operator syncs config files out of band and trusts they match. | Disqualified by core's own contract: §4.3 states plainly that a digest check alone is *not* a freshness check ("it cannot tell a node that its own map is a generation behind, because a stale map is internally consistent") and that skipping the staged transition reopens the exact two-holder bug §4.2's counterexample proves. A bare config read gives no way to detect a node running a stale generation, and no way to know when it is safe to activate a new one. Steady-state config-file-only would also require a process restart to pick up a change, contradicting §4.3's "steady-state locking never contacts the control plane" / one-shot-per-reconfiguration design. |
| **Chosen** | An operations-API-driven, per-node durable local record (extends the existing `LOCAL_ONLY hdb_nodes` row pattern `bumpHomeIncarnation` already uses) for the map itself; a digest of `(generation, homes[])` riding the existing capability-advertisement bag (`NODE_NAME[4]`) for agreement; and the §4.3 stage/quiesce/drain/activate sequence implemented as four operations the operator (or a script) invokes explicitly, gated by evidence recorded durably at each step. | Reuses three patterns this codebase already has proven safe: (1) `LOCAL_ONLY` rows for per-node durable state that must not LWW-merge across peers (`bumpHomeIncarnation`); (2) the `NODE_NAME[4]` capability bag + per-(database,peer) shared status buffer for cheap, already-wired cross-node agreement checks (`protocolCapabilities.ts`, `RECORD_LOCKS_CAPABILITY_POSITION`); (3) the existing `add_node`/`set_node` shape for an operator-invoked, per-node topology operation (`replication/setNode.ts`). No new subsystem — the map is stated, not derived, satisfying §4's invariant directly. |

## Design

### 1. Durable storage: a local-only `hdb_nodes` extension, per database

A new per-node, per-database durable record, written the same way `recordLockIncarnation`
already is — a `LOCAL_ONLY` merge into this node's own `hdb_nodes` row via `ensureNode`, so it
persists across restarts, is visible locally, and is **never** replicated or LWW-merged with a
peer's copy (peers only ever see a digest of it, over the capability channel, never the row
itself):

```ts
interface RecordLockHomesEntry {
	database: string;
	generation: number;
	homes: string[]; // sorted, canonicalized before storage and before hashing
}
// hdb_nodes.recordLockHomes: Record<database, RecordLockHomesEntry>
```

`homes[]` must be canonicalized (sorted, de-duplicated) before it is stored or hashed, so two
operators typing the same set in a different order do not manufacture a digest mismatch.

### 2. The operations API

Four new operations in `replication/recordLockHomes.ts`, mirroring `setNode.ts`'s shape
(Joi-validated request, `ensureNode` for the durable write, `handleHDBError` for validation
failures). All four are **per-node** — the operator (or an orchestration script) issues each
one on every node named in the old and new `homes[]`, exactly as §4.3 describes; harper-pro
does not attempt to fan a single call out to peers itself, because that would reintroduce a
"one caller must reach every node" coordination problem the operator-sequenced design exists
to avoid (see §4.2's table: the operator already has to act out of band to add/remove a node
from `homes[]`; issuing four ops instead of one does not add a new failure mode, it makes each
step's evidence independently durable and inspectable).

- **`record_lock_stage_generation`** `{ database, generation, homes[] }` — step 1. Validates
  `generation` is exactly `current.generation + 1` (or `1` when none exists yet — bootstrap) and
  writes a `staged: { generation, homes }` alongside the current `active` entry. Refuses (not
  a silent clamp) a generation at or below one already active or already staged higher, per
  §4.3 "the generation is also monotonic."
- **`record_lock_acknowledge_quiesce`** `{ database }` — step 2, invoked on each node named in
  `homes(g) ∪ homes(g+1)`. Refuses unless this node's coordinator has actually stopped
  granting and honoring delegations under the active generation (checked, not asserted: reads
  the live coordinator's granted-under-generation state — see "Coordinator wiring" below), then
  records `{ acknowledgedGeneration: g+1, homeIncarnation, at }` — **bound to this node's
  current `homeIncarnation`**, per round 10's fix, so a restart during the drain invalidates the
  acknowledgement (a re-check against the freshly-read `homeIncarnation` on `activate`, not a
  cached comparison, is what makes that binding real).
- **`record_lock_fence_external`** `{ database, node }` — the alternative to acknowledgement
  for a node that cannot be reached to quiesce: **the operator's attestation** that they have
  stopped it, isolated it, or powered it off (§4.3 step 2, "declaring a node removed is not a
  fence; stopping it is"). This call is the durable record of that attestation; it is
  intentionally not automatic or inferred from a liveness signal — that inference is exactly
  what round 7 rejected doing automatically. `super_user`-gated, same as other topology
  mutations.
- **`record_lock_activate_generation`** `{ database }` — step 4, invoked on each node. Refuses
  unless every node in `homes(g) ∪ homes(g+1)` has either a fresh acknowledgement (its
  recorded `homeIncarnation` matches its *current* one — re-read, not cached) or an external
  fence attestation, **and** `now ≥ lastAcknowledgementOrFenceTime + DELEGATION_LEASE_MS +
  LOCK_LEASE_SKEW_MS` (the drain interval, step 3 — folded into this check rather than a
  separate operation, since it is a pure wait with no side effect of its own). On success,
  writes the one durable **activation record** — `{ generation, homes, routingCapabilityVersion,
  acknowledgements, fences, notBefore }` — and only then does `homeMap()` start returning `g+1`
  on this node.

  **This makes activation itself a per-node decision, each one independently checking the same
  durable evidence** (the staged/acknowledged/fenced records), rather than one caller computing
  the answer once and broadcasting it — consistent with "no node ever derives... from what it
  observes" not applying to the *activation check* (which is a deterministic function of durably
  recorded facts, not of live liveness) while still applying to the *map itself* (never derived
  from `hdb_nodes` membership or reachability).

### 3. Digest agreement over the existing capability bag

`protocolCapabilities.ts`'s `NODE_NAME[4]` bag gains one key, `recordLockHomesDigest`: an
FNV-1a digest (the branch already has `ringVersionOf`'s implementation; reused, renamed
`digestOf`) over `` `${generation} ${homes.sorted().join(' ')}` `` for the database
being advertised on that connection. `resolvePeerCapabilities` resolves it like `subscriptionSetupBudgetMs`
(pass-through, not min-clamped or coerced to a level — a digest is not an "at least" comparison).
The per-(database,peer) shared status buffer gains one slot (30, the next free headroom slot
after 29) to hold it, written by `recordPeerLockCapability`'s sibling on receipt exactly as the
existing level is today.

A peer whose advertised digest does not match this node's own **active** generation's digest is
treated as an **absent** participant for this generation (same effect as
`LOCK_CAPABILITY_UNSUPPORTED` today) — not merely logged: participating with a node that disagrees
about `homes[]` is precisely the two-arbiters bug, and it must fail closed exactly like an
unadvertised capability does. This is the entire "agreement" mechanic: no ballots, no acceptors,
consistent with §4.1's "agreement is a digest comparison, not a protocol."

### 4. `homeMap()` and `homeIncarnation`

`createRecordLockTransport`'s `epoch()` becomes `homeMap()`, returning
`{ generation, homes, homeIncarnation }` sourced from the **active** (not staged) durable
record — never from live `hdb_nodes`/capability-derived membership. It returns `undefined`
when no active record exists yet (bootstrap) or `homeIncarnation` is not yet known on this
thread (existing restart-hold logic is dropped — the design doc's restart quarantine is now
core's own `grantableAfterMono`/construction-anchored responsibility (§4.3 "a restarted home is
the one interval core enforces itself"), not harper-pro's to duplicate; harper-pro instead
supplies `grantableAfterMono` where it can prove nothing else granted, exactly per that
section's last paragraph — deferred to implementation, flagged in "For the human reviewer" if
not reached).

`homeIncarnation` advances on **coordination incarnation**, not process start:
`bumpHomeIncarnation()` is called both at process start (unchanged) and from
`recordLockOwnerFor`'s reassignment path (`recordLockTransport.ts:500-523`) whenever the new
owner differs from the previous one for a database whose coordination was previously live —
i.e., a genuine handoff, not the first assignment. This closes the ordering hole described
above under "What this branch has wrong today."

## Testing

- Unit: digest determinism and canonicalization (order-independence, dedup); stage/acknowledge/
  fence/activate as a pure state machine (independent per-node clocks, per the merged design
  doc §12's note that a shared fake clock cannot express this); the monotonic-generation refusal;
  activation refusing on a stale (incarnation-mismatched) acknowledgement; `homeMap()` returning
  undefined pre-bootstrap and after a digest mismatch; `homeIncarnation` bumping on a genuine
  owner handoff and not on the first assignment.
- Integration (extends `recordLockCluster.test.mjs`): stage → all nodes acknowledge → activate →
  `homeMap()` agrees cluster-wide; a node excluded via digest mismatch fails its own locks closed
  while others continue; a fenced (not acknowledged) node's exclusion still activates after the
  drain interval; a node that acknowledges then restarts before activation blocks activation
  until it re-acknowledges under its new `homeIncarnation` (round 10's counterexample, made
  concrete).

## For the human reviewer (carried into the PR)

- The §4.3 drain/activate machinery here is the most protocol-sensitive part of this note and
  the part most likely to have a framing problem the planning review should catch — flagging it
  explicitly rather than asserting confidence.
- Genuinely deferred, not silently dropped: `grantableAfterMono` (cold-start override for a
  provably-first-ever node), the `lockRelease` cross-thread relay gap, and full every-thread
  transport registration — all named in the merged design doc's §11 "still owed" list but
  outside #825's redefined scope per the task owner's instruction.
