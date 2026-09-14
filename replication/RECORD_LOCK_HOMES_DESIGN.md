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

**Out of scope, deliberately** (the task owner's instruction was specifically "825," not the
rest of §11's "still owed" list): harper#2542's freshness fence, the `lockRelease`
cross-thread relay gap, and full every-serving-thread transport registration. Real, blocking
for *enablement*, and called out as findings — not folded in here.

**Revision history.** Round 1 of the planning review (`8f2f03890502`, `better-alternative-exists`)
found this note's first draft unsafe in four places — summarized under "What changed after
round 1," below the design. This is the revised note; §4.3 is now a materially different,
simpler mechanism than round 1 reviewed, so a second planning round is warranted before
implementation despite the "adopt, no second round" default, per
[design-alternatives.md](../../../.claude-devagent/skills/harper-engineering-guidelines/rules/design-alternatives.md)'s
"unless the switch opens a new question" — the mechanism itself is the new question.

## What this branch has wrong today

`replication/recordLockTransport.ts`'s `epoch()` derives `LockEpoch{number: 1, members,
ringVersion}` **locally, from live `hdb_nodes` + capability advertisement**, on every node,
independently — exactly the shape core's design doc now says must not exist: "no node ever
derives, proposes or advances one from what it observes" (§4). It cannot compile against
`homeMap()` at all, and even if it could, it still has the two-holder hole the PR's own `## For
the human reviewer` section already disclosed.

`homeIncarnation` is bumped once at process start and pushed to every worker. §5.1 requires it
to advance once per **coordination incarnation** — a process start *or* a coordinating-worker
restart — because coordinator state is per-thread: today, if the owning HTTP worker exits and
`recordLockOwnerFor` reassigns coordination to a fresh worker (`recordLockTransport.ts:476-491`),
the replacement gets the *same* `homeIncarnation`, so its delegation counter restarts at zero
under an unchanged incarnation — exactly the ordering hole §5.1 names.

## The invariant this change enforces

**At most one generation is ever live, cluster-wide, for a given database's home map — no node
may treat a newer generation as active until every node that could still be granting under the
generation it is displacing has had the full delegation-lease window to have stopped, whether or
not that node is reachable to confirm it.**

## Approaches considered

**Root cause:** the home map is currently *derived* (computed independently by each node from
data that can disagree), when core's contract requires it to be *stated* (published once,
identically, and verified to be identical before use).

| Axis | Candidate | Why not chosen / why chosen |
|---|---|---|
| **Different layer** | Move home-map ownership into core. | Disqualified by core's own docstring — `homeMap()` is "supplied by harper-pro; core never computes it" (`recordLockCoordinator.ts:105`) — and design-doc §4: "harper-pro owns this, because it owns topology." Round 1's framing check confirmed this axis is correctly closed. |
| **Deeper cause** | Rebuild automatic, consensus-derived rehoming (the epoch protocol #825 originally specified). | Already rejected upstream, at the core-design level, not by me: design-doc §9 "Do more" row and §14's round-7 ruling, with a recorded disqualifier (a durable consensus subsystem is "unpaid complexity" when an operator can simply state the answer). Round 1 confirmed this axis is correctly closed too. Not reopened here. |
| **Do less** | (a) Global hot-reloadable config, no digest check, no staged transition. (b) *Round 1's addition, adopted below in a further-reduced form*: fence/stop every affected node, wait the full delegation interval, publish the next map, restart — no online acknowledgement protocol. | (a) disqualified per round 1: skips the exact mechanism (§4.3's staged transition) core's own doc says is not optional — "a digest check is not a freshness check." (b) is the axis round 1 found missing from the first draft, and it is **chosen**, in the reduced form below: no acknowledgement round trip and no restart requirement either — see "Do less, taken further" below for why round 1's own proposal (an online ack protocol with a canonical activation artifact) is *itself* more than the invariant needs. |
| **Chosen** | A local, per-node, wall-clock timer anchored at stage-receipt: durable per-database `{active, staged}` records (dedicated local-only table, not a shared-row blob field); an operator-driven `stage` call fanned out to every node in `homes(g) ∪ homes(g+1)`; each node **independently** promotes `staged → active` once its own `Date.now() - stagedAt ≥ DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS`, with no cross-node acknowledgement, canonical artifact, or restart required. | Satisfies the invariant without a distributed-evidence-collection step: safety comes from every affected node's own drain timer, not from any node learning what another node has done — which sidesteps round 1's blocker #2 (local-only evidence cannot support a cross-node check) entirely rather than solving it. See "Why this is still safe" below for the argument that a per-node timer is sufficient. |

### Do less, taken further: why an online acknowledgement protocol is more than the invariant needs

Round 1's suggested fix — a trusted orchestrator collecting incarnation-bound acknowledgements
into one canonical activation artifact, applied idempotently everywhere — closes every blocker
it found, but it does so by solving a harder problem than the invariant requires: it establishes
common knowledge of *when every node has stopped*, so that activation can be timed off the *last*
node to comply. The invariant above does not need that. It needs only that **no node exposes
`g+1` before the delegations it could have issued under `g` are guaranteed expired**, and each
node can guarantee that about *itself*, unconditionally, from a purely local fact: the durable
timestamp at which *it* was told about `g+1`. Waiting `DELEGATION_LEASE_MS + skew` from that local
timestamp is at least as conservative as waiting from a cluster-wide "last acknowledgement" instant,
because a node cannot promote before it has itself been staged, and the moment it is staged is no
earlier than the moment the operator's fan-out reaches it.

This also removes the restart requirement from round 1's earlier draft entirely: quiescence does
not need a process restart to be real, because "stopped granting under `g`" here is not an
observed behavior to attest to — it is a **timer expiry**, checked identically by the grant path
on every call, restart or not. (`homeIncarnation`'s own per-coordination-incarnation advance
below still needs the owner-handoff fix regardless of this choice — that is a different property,
addressed on its own.)

**What this trades away**, honestly, per the design-note bar on stating costs rather than
implying them: activation is not observable from a single node's status the instant every peer
has actually drained — a node cannot promote *early* even if every peer happened to comply
faster than the worst case, because it has no way to know that. The wait is always the full
`DELEGATION_LEASE_MS + skew`, whereas an acknowledgement-driven scheme could in principle
activate sooner when every node responds quickly. That is the same shape of cost §4.3 already
pays for the restart quarantine core enforces on its own (`grantableAfterMono`) — a conservative
fixed wait instead of a tighter one bought with more machinery — and this design accepts it for
the same reason: the wait is bounded and rare (once per reconfiguration), and the machinery it
buys back (distributed acknowledgement collection, a canonical-artifact distribution mechanism,
restart-triggered rejoin) is the harder problem V1 does not need to solve.

**The one thing this does NOT relax**: a node the operator's fan-out never reaches (down,
partitioned) never receives a `stagedAt` and so never starts its own timer — it will keep
granting under `g` indefinitely if it comes back later still running the old process. That is
exactly why `record_lock_fence_external` still exists: for a node the operator cannot stage,
the operator's own attestation that they stopped it outside Harper (§4.3, "declaring a node
removed is not a fence; stopping it is") is what prevents it from resuming as a live `g` grantor.
Unlike round 1's design, this attestation needs no distribution to other nodes and no runtime
check by anyone — it is a durable audit record of an operator action whose safety is guaranteed
by the action itself (the node is stopped), not by anything Harper verifies. It is recorded
locally on whichever node the operator happens to be talking to, for audit history only.

## Design

### 1. Durable storage: a dedicated local-only table, not a shared-row field

Round 1's blocker #5: a JSON blob patched onto the operator's own `hdb_nodes` row has no
per-database atomicity — concurrent operations for two databases can race a read-modify-write
on the same object, and a restart can let a generation regress. **Fix: a dedicated system table**,
`hdb_record_lock_homes`, one row per `database`, `LOCAL_ONLY` (never replicated — each node
holds only its own copy, exactly like `recordLockIncarnation`'s existing row, but as its own
table rather than a field grafted onto `hdb_nodes`):

```ts
interface RecordLockHomesRow {
	database: string; // primary key
	active?: { generation: number; homes: string[]; digest: string };
	staged?: { generation: number; homes: string[]; digest: string; stagedAt: number }; // stagedAt: Date.now()
	highestActedOn: number; // monotonic floor; survives active/staged being cleared
	fenced?: { node: string; at: number; operator: string }[]; // audit only, not consulted by any grant path
}
```

Writes go through the table's own transactional API (compare-and-set on `database`, not a
whole-row patch of a shared object), so two databases' stage calls cannot race each other and a
generation write is atomic per row.

### 2. The operations API

Two mutating operations, `replication/recordLockHomes.ts`, mirroring `setNode.ts`'s shape
(Joi-validated, `super_user`-gated, idempotent, generation-bound so a stale retry cannot apply
to the wrong transition):

- **`record_lock_stage_generation`** `{ database, generation, homes[] }` — issued by the
  operator on every node named in `homes(g) ∪ homes(g+1)`. Canonicalizes `homes[]` (sort,
  dedup) before storing or hashing. Refuses a `generation` at or below `highestActedOn`
  (monotonic floor, survives a restart). Computes `digest = sha256(generation + '\0' +
  homes.join('\0'))` and durably writes `staged = { generation, homes, digest, stagedAt:
  Date.now() }`. Idempotent: re-issuing the identical `(generation, homes)` is a no-op success;
  a different `homes[]` for a `generation` already staged is rejected (round 1 blocker #8).
- **`record_lock_fence_external`** `{ database, node, operator }` — the operator's durable,
  audit-only attestation that an unreachable node has been stopped outside Harper. Appended to
  `fenced[]`. Not consulted by any grant-path check — see "What this does NOT relax," above.

No separate acknowledge or activate operation. Promotion is automatic and purely local (below).

### 3. Promotion: a local timer, not a call

`homeMap()`'s read path, on every call: if `staged` exists and `Date.now() - staged.stagedAt ≥
DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS`, atomically promote it (`active = staged; staged =
undefined; highestActedOn = max(highestActedOn, active.generation)`, durably, exactly once —
compare-and-set against the row's current state so a concurrent caller cannot double-promote)
before reading. This is checked off the hot path (see "Caching," below) — the promotion check
itself runs on a slow timer/on load, not on every `homeMap()` call.

### 4. Caching — round 1 blocker #1

`homeMap()` must be a lock-free pointer read on the hot path: core calls it before reusing even
a live delegation. Per thread, cache one frozen `LockHomeMap | undefined`, invalidated only by
(a) this thread's own promotion check firing, on a coarse interval (e.g. checked once per
`EPOCH_MEMO_MS`-equivalent tick, not per call — the existing memo window the branch already
uses for the static epoch generalizes directly), or (b) a fresh `stage`/`fence` write landing on
this node. No per-call I/O, hashing, sorting, or allocation — the frozen object is what
`homeMap()` returns.

### 5. Digest — round 1 blocker #7

FNV-1a in one `Float64` slot is not a real agreement proof (32-bit collision risk, NUL-delimiter
ambiguity). The full digest travels in the `NODE_NAME[4]` capability bag as a hex string
(`recordLockHomesDigest`, per database — see "Handshake," below), compared byte-exact on the
socket thread on receipt. Only a **tri-state match result** (unknown / match / mismatch) goes
into the per-(database,peer) shared status buffer, at the next free slot (30) after the
existing capability-level slot (29) — mirroring the existing `LOCK_CAPABILITY_*` enum shape
exactly.

A digest mismatch excludes that peer from this node's ring **and this node from that peer's
ring, symmetrically** — each side independently computing its own exclusion from its own
comparison, not one side inferring which of the two is stale (round 1 blocker #9). Steady-state
mismatch (both nodes holding what they believe is the *same* active generation, yet computing
different digests for it) indicates a real problem — corruption or a bug — and both sides fail
that peer out of the ring rather than guessing which is right.

### 6. Handshake — round 1 blocker #6

`LOCAL_CAPABILITIES` is currently a process-wide constant built once at module load
(`replicationConnection.ts:686`) and sent only in `NODE_NAME`, which is itself sent once per
`(connection, database)` at handshake (`:7840`) — never refreshed on an already-live socket.
Because promotion is a local timer with no distribution step, an activated node does not
automatically push its new digest to peers it is already connected to. **Fix:** compute the
per-database digest fresh at the `NODE_NAME` send call site (not baked into the frozen
`LOCAL_CAPABILITIES` object), and re-send `NODE_NAME` on every live outbound connection for a
database whose row transitions `staged → active` locally (a small, targeted re-announce, not a
reconnect) — plus, unavoidably, on any ordinary reconnect. A peer's digest is only ever refreshed
by receiving a fresh `NODE_NAME`; there is no separate push channel.

### 7. `homeIncarnation` per coordination incarnation — round 1 blocker #4

`bumpHomeIncarnation()` must complete (durably persist) *before* a replacement worker is
conferred ownership, not run concurrently with it. `watchOwnerExit`'s reassignment
(`recordLockTransport.ts:476-491`) becomes: on a genuine handoff (the new owner differs from a
previously-live owner for that database — not the first assignment), `await bumpHomeIncarnation()`
before calling `recordLockOwnerFor`; if the bump fails (persistence error), coordination for that
database stays **unowned** rather than being assigned under a stale incarnation (fail closed,
matching the module's existing default). Concurrent reassignments across databases must not race
the read-increment-write in `bumpHomeIncarnation` — serialize it behind a single in-flight guard.

### 8. Wire/capability version bump — round 1 blocker #8

`RECORD_LOCKS_CAPABILITY` moves from 2 to 3: the wire shape changes (`epoch` → `generation` in
`DelegationRequest`/reply; the new digest key in the capability bag), and per the merged design
doc's "Protocol version and mixed deployments," levels are versioned and mutually exclusive even
though level 2 never shipped enabled — a partially-upgraded node must not misinterpret an
old-shape payload as new.

## Why this is still safe — the round-10 counterexample, re-checked

`A` acknowledges (in this design: durably receives `stage(g+1)`, recording `stagedAt`), then
restarts during the drain. Its promotion state is **durable, keyed by wall-clock `stagedAt`, not
by anything the restart discards** — `stagedAt` is read back from the row, unaffected by the
restart, so the drain timer is exactly where it was. A cannot promote early because of the
restart (nothing accelerates the timer) and cannot promote late in a way that matters (a slower
promotion is conservative, not unsafe). No re-acknowledgement is needed because there was never
an acknowledgement to go stale — replacing "an acknowledgement, which can become stale" with "a
durable fact, which cannot" is the core of why this design has no counterpart to round 1's
blocker #2 at all.

## Testing

- Unit: digest determinism/canonicalization; stage idempotency and the monotonic-generation
  refusal (including across a simulated restart — a fresh row load with `staged` already past
  its drain must promote once, not re-promote or lose the generation); promotion as a pure
  function of `(now, stagedAt)` with an injected clock (independent per-node clocks per the
  merged design doc §12, not a shared fake clock); `homeMap()` cache invalidation timing;
  `homeIncarnation` bumping on a genuine owner handoff and not on first assignment, and the
  fail-closed path when the bump fails.
- Integration (extends `recordLockCluster.test.mjs`): stage on every node → all promote after
  the drain interval (test-overridden, like `RESTART_HOLD_MS` already is) → `homeMap()` agrees
  cluster-wide, including a key whose home moved; a node the stage call never reached (simulated
  partition) does not promote and, on rejoining after `record_lock_fence_external` was recorded
  for it, its own late-arriving `g` grants are refused by peers on generation mismatch; digest
  mismatch excludes a peer symmetrically on both sides; a node that restarts mid-drain still
  promotes at the original `stagedAt + drain`, not earlier or later.

## For the human reviewer (carried into the PR)

- **This is a materially different §4.3 mechanism than the merged core design doc's own prose
  describes** (stage → *quiesce/acknowledge*-or-fence → drain → activate). This note replaces
  the acknowledge/activate steps with a per-node timer, on the argument in "Do less, taken
  further" that the invariant does not require cross-node evidence collection. That argument is
  the thing most worth a second, skeptical read — if it is wrong, the fix is closer to round 1's
  original suggestion (a canonical activation artifact), not a patch on this one.
- Genuinely deferred, not silently dropped: the `lockRelease` cross-thread relay gap and full
  every-thread transport registration — named in the merged design doc's §11 "still owed" list
  but outside #825's redefined scope per the task owner's instruction.

## What changed after round 1

Round 1 (`8f2f03890502`, `better-alternative-exists`) found the first draft's transition
mechanism unsafe: local-only acknowledgement evidence cannot support a cross-node activation
check (blocker #2); "acknowledge" observed state without establishing real quiescence (blocker
#3); the incarnation bump could race owner handoff (blocker #4, fixed in §7 above regardless of
which transition mechanism was chosen); a shared-row JSON blob was not atomic per database
(blocker #5, fixed in §1); the capability bag needed active renegotiation on activation (blocker
#6, fixed in §6); FNV-1a was too weak an agreement proof (blocker #7, fixed in §5); the
operations needed uniform authorization and replay binding (blocker #8, fixed in §2/§8); and the
proposed tests didn't prove safety, including an asymmetric digest-mismatch test (blocker #9,
fixed in §5). Round 1 also named a missing "do less" option — fence/stop/wait/restart — which
this revision adopts in a further-reduced form that needs neither restart nor acknowledgement;
see "Do less, taken further."
