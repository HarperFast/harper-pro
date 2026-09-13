# Cluster record locks: cost after the delegation protocol (harper-pro#824)

The after-figures for amortized per-record ownership, against the Ricart–Agrawala before-figures in
[`RECORD_LOCK_COST_BASELINE.md`](RECORD_LOCK_COST_BASELINE.md). Same bench, same box, same structure.
Numbers, not tuning: nothing in the lock protocol was changed to produce them.

```
npm run bench:record-locks
```

`integrationTests/cluster/recordLockCost.bench.mjs` boots the same 3-node full mesh
`recordLockCluster.test.mjs` proves correct (`threads.count: 1`, `replication.recordLocks: true`),
then three standalone nodes for the disabled arms. Timing is taken inside the nodes
(`fixture-record-lock-bench`), so the distributions are the lock machinery's, not the HTTP client's.
The raw results of every run land in a JSON file (`RECORD_LOCK_BENCH_OUT`). Not part of
`test:integration:cluster`: it measures, it does not gate.

The feature is enabled for the bench cluster only, through the existing `replication.recordLocks`
gate, with `HARPER_TEST_RECORD_LOCK_RESTART_HOLD_MS=0` to lift the six-minute restart hold. The
default is unchanged and still off.

**The BEFORE and AFTER substrates are not identical, and two rows are sensitive to it.** The baseline
was taken with `core` on the Ricart–Agrawala commit, which sat on an older harper `main`; this run's
`core` is the rebased phase-1 head, which carries ~58 files of unrelated change (logging rotation,
npm utilities, config validation) along with the protocol. Rows whose delta is structural or an
order of magnitude — repeat-lock latency, control entries per acquisition, the home split — cannot be
explained by that, and no amount of unrelated logging change turns 4 durable commits into 0. The rows
that _are_ sensitive are measurement 1's pooled figure and measurement 5's absolute throughput, and
neither carries an argument here that depends on a small difference. Re-measuring the before-figures
on this substrate would need the Ricart–Agrawala code back, which the branch has deleted.

**Which code this measures.** harper-pro#822's branch head with the `core` submodule at the current
harper#2498 head. #822 had pinned `core` at a commit that a later force-push of
`feat/record-lock-phase1` left unreachable, four commits behind — two of which change grant and
delegation holding directly, which is what measurements 2 and 3 exist to exercise — so measuring the
old pin would have measured code that is not going to ship.

**What the protocol does not yet do, which two rows below depend on.** Core's coordinator states at
`resources/recordLockCoordinator.ts:43` that the successor-freshness fence of §7 — the inherited
`(origin → position)` dependency set on the release entry, and the recovery barrier — is
deliberately not implemented, and that it is harper#2542. §14 names a second route to the same
effect: §6 step 3 settlement is not implemented, so a recall revokes capability and writes the
release without waiting for a native commit it already submitted. Until both land, **a handoff
carries exclusion but not freshness.** That is why the recovery-path row cannot be measured at all,
and why measurement 3's counter no longer reaches the section count. Neither is a defect found by
this run; both are disclosed positions being costed.

**Machine class for the figures below:** one laptop, 12th Gen Intel i7-12700H (20 threads), 31 GiB, Linux x64, Node v26.2.0 — every node on its own loopback address, so the
network round trip is microseconds and every figure is a lower bound on what a real cluster pays.
Three nodes plus the client share the box; the run-to-run spread noted under each measurement is that
sharing, over three full runs.

## Summary

| §10 row                                     | BEFORE (Ricart–Agrawala) | AFTER (delegations)                  | verdict                       |
| ------------------------------------------- | ------------------------ | ------------------------------------ | ----------------------------- |
| First lock, key homed elsewhere — 1 RTT     | 1.07 ms p50              | 0.37 ms p50                          | as predicted                  |
| First lock, key homed here — 0 RTT          | 1.07 ms p50              | 0.04 ms p50                          | as predicted                  |
| Steady state — local key lock, 0 messages   | 0.68 ms p50              | **0.01–0.03 ms p50**                 | as predicted, 20–60x          |
| Durable commits per uncontended acquisition | 4 (~310 B)               | **0**                                | as predicted                  |
| Durable commits per contended section       | 4                        | 0.023–0.054 release entries          | as predicted                  |
| Hot-key handoff throughput                  | 877–911 sections/s       | 1 031–1 707 sections/s               | faster, but see fairness      |
| Hot-key exact convergence                   | exact, every run         | **0.05–0.13 % lost at 3 contenders** | **not met — harper#2542**     |
| Hot-key fairness                            | shared by turn-taking    | **loser starved in 2 of 3 runs**     | **not a §10 row; found here** |
| Write throughput, feature off vs absent     | inside noise             | inside noise                         | as predicted                  |
| Delegation re-acquisition rate              | n/a                      | `gap / (360 s − lease)`              | exact at the 60 s window      |
| Cold-key recovery path                      | n/a                      | **unmeasurable**                     | harper#2542 not implemented   |

Two results are worth a reader's attention beyond the table. The hot-key row can buy its throughput
with **starvation**: in two runs of three at two contenders the losing node completed **no critical
section at all while the key was held**, and over a 40 s round it got zero sections and one
user-visible `423`. In the third run the identical workload split 58/42, so this is a regime the
protocol can enter rather than one it always enters. And the convergence row is a **disclosed** gap
being costed, not a defect found.

## 1. Uncontended acquisition latency

`table.lock(id, { hold: true })` on distinct keys, 120 acquisitions per node, each node requesting in
turn while the other two are idle. The bench now records, per key, whether the requesting node is the
key's home, by watching whether the lock minted a grant on this node — so §10's two predicted costs
are separated rather than pooled.

| ms                                       | n   | min  | p50  | p95  | p99  | max  | mean |
| ---------------------------------------- | --- | ---- | ---- | ---- | ---- | ---- | ---- |
| acquire — BEFORE                         | 360 | 0.58 | 1.07 | 2.02 | 2.48 | 3.75 | 1.17 |
| acquire — AFTER, pooled                  | 360 | 0.02 | 0.25 | 0.78 | 1.47 | 1.90 | 0.31 |
| acquire — AFTER, this node homes the key | 122 | 0.02 | 0.04 | 0.13 | 0.28 | 0.46 | 0.06 |
| acquire — AFTER, home elsewhere          | 238 | 0.15 | 0.37 | 0.86 | 1.54 | 1.90 | 0.43 |
| release — BEFORE                         | 360 | 0.05 | 0.07 | 0.15 | 0.18 | 0.24 | 0.09 |
| release — AFTER                          | 360 | 0    | 0.01 | 0.02 | 0.05 | 0.06 | 0.01 |

| control entries per acquisition | requester | each grantor | cluster total  |
| ------------------------------- | --------- | ------------ | -------------- |
| BEFORE                          | 2 (150 B) | 1 (79–80 B)  | **4 (~310 B)** |
| AFTER                           | 0         | 0            | **0**          |

Across three runs: pooled p50 0.25–0.31, home-local p50 0.04–0.05, remote-home p50 0.36–0.46 and p95
0.85–0.95. 122, 109 and 130 of each run's 360 keys were homed on the requesting node (30–36 %, against
the 1/3 a three-member ring predicts).

§10 predicts two costs for a first lock, not one — **1 RTT to the home, and 0 when this node homes
the key**. Pooling them, as the baseline had to, hides exactly that. Split, both hold: a home-local
acquisition is 0.04 ms p50, a remote-home one 0.37 ms, and the pooled figure sits between them in the
ratio the ring produces.

§10 also predicts **zero durable commits**. Measured: zero control entries on every node in every
run, for all 360 acquisitions, against the baseline's four per acquisition cluster-wide. The
delegation request and its reply are unicast RPC and never reach the transaction log.

The release figure is not comparable work in the two rows: under Ricart–Agrawala `unlock()` returned
ahead of a release entry that still had to commit, while here an uncontended `unlock()` writes
nothing at all, because the delegation is deliberately retained.

## 2. Repeat-lock latency

One node locking the same key over and over. The first lock is reported apart from the repeats, on a
key the node homes and on one it does not, because under a delegation only the first lock can cost
anything.

| ms                                      | n   | min  | p50  | p95  | p99  | max  | mean |
| --------------------------------------- | --- | ---- | ---- | ---- | ---- | ---- | ---- |
| BEFORE — every lock                     | 200 | 0.46 | 0.68 | 1.76 | 3.93 | 7.08 | 0.87 |
| AFTER — repeats, key homed on this node | 200 | 0.01 | 0.02 | 0.04 | 0.07 | 0.11 | 0.03 |
| AFTER — repeats, key homed elsewhere    | 200 | 0.01 | 0.01 | 0.02 | 0.06 | 0.23 | 0.01 |

| first lock, reported apart | AFTER (three runs)    |
| -------------------------- | --------------------- |
| key homed on this node     | 0.13 / 0.20 / 0.28 ms |
| key homed elsewhere        | 1.09 / 1.10 / 1.23 ms |

Control entries for the whole test — both first locks and all 400 repeats — were **0** on every node
in every run. Repeat p50 was 0.01–0.03 ms across runs.

This is the row the protocol exists for, and the collapse is the largest single change in this
document: **0.68 ms → 0.01–0.03 ms, 20–60x**, with zero cluster messages and zero log entries.
§10's steady-state row — _0 durable commits, 0 frame deliveries, local key lock_ — is met.

Splitting by home also isolates the one cost that remains. A first lock on a key homed elsewhere is
1.1–1.2 ms, paid once per delegation rather than once per lock — and that is an upper bound on the
round trip rather than the round trip itself, because these probes run without the warm-up
measurement 6 establishes is necessary and so carry a cold request's first-lock cost on top of the
cluster call.

How much that cost is, is the next row of the same table: a first lock on a key this node homes is
**0.13–0.28 ms with no cluster call whatsoever**. That is the floor under the 1.1 ms figure, it is
the same order as a loopback round trip, and it is why measurement 6 cannot take its sample from the
first lock in a request.

## 3. Hot-key handoff throughput

One key; each contending node keeps exactly one `lock → read → increment → save` request in flight
for 15 s, the request transaction's commit being the unlock (`LockedIncrement`). This is the case
that pays a full handoff.

| contenders    | sections | sections/s | lock p50 / p95 / p99 (ms) | lock max (ms) | section p50 / p95 | request p50 / p95 | 423s |
| ------------- | -------- | ---------- | ------------------------- | ------------- | ----------------- | ----------------- | ---- |
| 2 of 3 BEFORE | 13 159   | 877        | 1.05 / 2.8 / 3.5          | —             | 1.13 / 3.0        | 1.77 / 4.4        | —    |
| 2 of 3 AFTER  | 15 492   | 1 031      | 0.05 / 0.17 / 1.03        | 586           | 0.13 / 0.39       | 0.59 / 1.64       | 0    |
| 3 of 3 BEFORE | 13 667   | 911        | 2.01 / 4.9 / 5.8          | —             | 2.10 / 5.1        | 2.70 / 6.4        | —    |
| 3 of 3 AFTER  | 18 690   | 1 241      | 0.05 / 0.12 / 0.57        | 2 826         | 0.13 / 0.32       | 0.55 / 1.36       | 0    |

The AFTER rows are run 1. Across three runs: 2 contenders 1 031–1 707 sections/s, 3 contenders
1 213–1 374; lock p50 flat at 0.04–0.05 ms; lock max 586–15 042 ms at 2 contenders and 987–2 826 ms at 3. The aggregate rate moves further than the baseline's ±15 %, and the reason is the fairness regime
below rather than measurement noise.

The lock itself is **20–40x cheaper** — 0.05 ms p50 against 1.05 and 2.01 ms — because a section that
already holds the key finds the delegation in hand. That part is exactly what §10 predicts.

Two things about the aggregate rate mean it should not be read as "2x the baseline on the same
workload":

- **The tail is four orders of magnitude worse than the median.** p99 is 0.12–1.03 ms and the maximum
  reaches **15 seconds**. That is not jitter; it is one contender waiting essentially the whole run.
- **The rate and fairness are no longer the same quantity.** Under Ricart–Agrawala every section paid
  a round, so the throughput _was_ the turn rate and the nodes shared it. Under delegations the rate
  is dominated by whichever node is holding.

### Fairness: a contended key can be monopolized, and then the loser is starved

Sections completed per node, same runs:

| run | contenders | sections per node      | share          | worst lock per node (ms) |
| --- | ---------- | ---------------------- | -------------- | ------------------------ |
| 1   | 2          | 9 017 / 6 475          | 58 / 42 %      | 510 / 586                |
| 2   | 2          | 25 691 / **1**         | 100 / 0 %      | 0.96 / **15 042**        |
| 3   | 2          | 24 826 / **1**         | 100 / 0 %      | 1.30 / **15 035**        |
| 1   | 3          | 3 809 / 12 348 / 2 533 | 20 / 66 / 14 % | 2 649 / 902 / 2 826      |
| 2   | 3          | 13 637 / 4 003 / 3 064 | 66 / 19 / 15 % | 527 / 1 330 / 1 205      |
| 3   | 3          | 8 428 / 2 953 / 6 886  | 46 / 16 / 38 % | 581 / 987 / 951          |

**Two contenders produce one of two regimes, and the bad one is total.** In runs 2 and 3 the loser
completed **no section at all while the key was held**. Its single recorded section is an artifact of
the measurement window closing: the loser's `lastN` is the cluster _maximum_ (25 692 against the
winner's 25 691), so that write landed after the winner's loop ended and dropped the key, not during
the round. Its one `lock()` call sat waiting for the whole 15 s. In run 1 the identical workload split
58/42 with a worst lock of 586 ms. Same bench, same box, same key construction: the outcome is
bistable rather than consistent, which is itself worth noticing, because a regime that appears in two
runs of three will appear in production.

The `lockRelease` counts separate the two regimes cleanly, and show the bad one is not simple
monopolization — which would at least be cheap:

- **Run 1, shared:** 327 and 262 releases, on **both** nodes. The key genuinely changed hands.
- **Runs 2 and 3, starved:** 598 and 597 releases, all on the winner and **none** on the loser. So
  the loser did ask; ~597 times the home recalled the key and the holder drained and surrendered —
  and then **won the re-grant race back**, ~596 times out of 597. The full recall machinery ran six
  hundred times and moved the key to the asking node once.

**Why the holder keeps winning that race is not settled here, and it should be before enablement.**
The plausible reason is that it races from a standing start: a recall forces the holder's own next
lock to re-request (`#liveDelegation` refuses a recalled delegation), so it is already asking when the
release lands, and if it is also the key's **home** its re-request is `#grantLocally`, a function
call, against a round trip for everyone else.

Two observations point that way without settling it. The winner is not a fixed node — run 3 reverses
it — so it is a property of the key rather than of node or start order. And in a separate run where
the key was deliberately touched from all three nodes before the round, the 2-contender split moved
from 100 % / 0 % to 66 % / 34 %, which is what one would expect if the advantage belongs to whoever
holds first rather than to a node.

An attempt to attribute the winner to the key's home directly was **abandoned rather than reported**:
the only signal a fixture can read is the coordinator's grant gauge, and that moves only on a lock
that mints a grant where none existed — so it answers for the first node asked and is silently false
for every node after it, and asking at all moves the delegation and changes the round it is trying to
describe. The instrument was removed rather than shipped with those semantics. Settling this needs a
counter core does not currently expose.

**The zero in the 423 column is an artifact of the measurement window, and a fourth run confirms
it.** `DEFAULT_LOCK_TIMEOUT_MS` is 30 s (`core/resources/recordLock.ts:23`) while the rounds above run
for 15 s, so a contender starved for the whole round still never reaches its timeout. Re-run at
`RECORD_LOCK_BENCH_HOT_KEY_MS=40000`, past the timeout:

| contenders | duration | sections | sections/s | sections per node      | 423s  | lost |
| ---------- | -------- | -------- | ---------- | ---------------------- | ----- | ---- |
| 2 of 3     | 40 s     | 55 062   | 1 375      | **1** / 55 061         | **1** | 0    |
| 3 of 3     | 40 s     | 39 700   | 991        | 24 541 / 7 867 / 7 292 | 0     | 60   |

Read the order carefully, because it is the opposite of the 15 s rows and it is the point: the
starved node's **first** request waited out `DEFAULT_LOCK_TIMEOUT_MS` and **failed with `423 Record is
locked and was not released in time` while the holder was still running**. Its second request then
started at ~30 s and completed at ~40 s — a 10.0 s wait — only because the holder's loop ended there.
Its `lastN` is again the cluster maximum (55 062 against the winner's 55 061), confirming that write
landed after the round rather than in it.

So over forty seconds of contention the starved contender got **zero** critical sections and one
user-visible failure. (The 3-contender row of the same run lost 60 of 39 700 sections, 0.15 %, the
highest rate seen — consistent with a longer round giving more handoffs to lose at.) So a hot key does not merely skew throughput: **a contender can
be starved to the point of user-visible failure**, while the holder runs at full rate and the cluster
reports no error anywhere else. That is the finding to weigh against the throughput number, and it is
worth a decision before enablement (harper-pro#825) rather than after.

### The counter no longer converges exactly, and that is disclosed rather than new

| run | contenders | sections | counter, all nodes | lost | duplicate values | duplicates across two nodes | holes below the max |
| --- | ---------- | -------- | ------------------ | ---- | ---------------- | --------------------------- | ------------------- |
| 1   | 2          | 15 492   | 15 492             | 0    | 0                | 0                           | none                |
| 2   | 2          | 25 692   | 25 692             | 0    | 0                | 0                           | none                |
| 3   | 2          | 24 827   | 24 827             | 0    | 0                | 0                           | none                |
| 1   | 3          | 18 690   | 18 665             | 25   | 25               | 25                          | none                |
| 2   | 3          | 20 704   | 20 694             | 10   | 10               | 10                          | none                |
| 3   | 3          | 18 267   | 18 249             | 18   | 18               | 18                          | none                |

Every section's written value is audited, because "the counter is short" on its own does not say
what went wrong. It does now:

- **The shortfall equals the duplicate count exactly**, in all six rounds.
- **Every duplicate was written by two different nodes** — never the same node twice.
- **There are no holes below the highest value written**, so no committed write vanished.
- There were **no** non-200 responses and no 423s at all.

That is a successor reading a value its predecessor had committed and not yet replicated: two nodes
computed `n + 1` from the same `n`. It is a freshness failure at the handoff boundary, not an
exclusion failure and not a lost commit — and it is the disclosed position, not a discovery. Core
states at `resources/recordLockCoordinator.ts:43` that the §7 successor-freshness fence is
deliberately unimplemented and is harper#2542; §14 adds that §6 step 3 settlement is unimplemented
too, so a recall "writes the release without waiting for a native commit already submitted to
complete". Either route produces exactly this.

**The rate is 0.05–0.13 % of sections, and only at 3 contenders.** All three 2-contender rounds
converged exactly. That is not evidence that two nodes are safe: run 1's 2-contender round _did_
circulate the key (589 releases split across both nodes) and still lost nothing, but runs 2 and 3
barely handed it over at all, so the sample of real two-node handoffs is small in two runs of three
and the zero should not be read as a property.

**This is why harper-pro#824's stated expectation could not be met as written.** The task asked that
the counter still converge exactly. It cannot, on the hot path, until harper#2542 lands — so the
bench no longer asserts it. It waits for the value the nodes settle on, records `agreedCounter`,
`lostUpdates` and the full audit, and leaves the judgement to the reader; the call site names
harper#2542 and §6 step 3. Keeping the assertion would have made `npm run bench:record-locks` fail on
every run while measuring a guarantee this phase does not offer, and the bench measures rather than
gates.

**harper#2542's absence is therefore wider than the cold-key row.** It does not only make the
recovery path unmeasurable; it costs correctness on the ordinary contended path, at a rate this run
now puts a number on.

## 4. Transaction-log cost per acquisition

Read from each node's own `Counter` transaction log (`auditStore.getRange`) before and after a fixed
number of rounds. Bytes are the stored value per entry; the log key adds 8 bytes each.

Uncontended (120 acquisitions per node, each node in turn) and repeat-lock (2 x 200 repeats), per
acquisition:

| role               | BEFORE entries | BEFORE bytes | AFTER entries | AFTER bytes |
| ------------------ | -------------- | ------------ | ------------- | ----------- |
| requester          | 2              | 150          | **0**         | **0**       |
| each of 2 grantors | 1              | 79–80        | **0**         | **0**       |
| **cluster total**  | **4**          | **~310**     | **0**         | **0**       |

Under contention (the hot-key runs above), `lockRelease` entries against sections completed:

| run | contenders | releases per node | releases | sections | releases per section | regime  |
| --- | ---------- | ----------------- | -------- | -------- | -------------------- | ------- |
| 1   | 2          | 327 / 262 / 0     | 589      | 15 492   | 0.038                | shared  |
| 2   | 2          | 598 / 0 / 0       | 598      | 25 692   | 0.023                | starved |
| 3   | 2          | 597 / 0 / 0       | 597      | 24 827   | 0.024                | starved |
| 1   | 3          | 187 / 680 / 145   | 1 012    | 18 690   | 0.054                | —       |
| 2   | 3          | 628 / 179 / 147   | 954      | 20 704   | 0.046                | —       |
| 3   | 3          | 356 / 173 / 403   | 932      | 18 267   | 0.051                | —       |

BEFORE, the same rows were **4 entries per acquisition**, contended or not.

The baseline's `P+1 = 4` durable commits per acquisition (1 request + 2 grants + 1 release) are gone
from the uncontended and repeat paths **entirely**: the delegation protocol carries request and grant
as unicast RPC, and a release is the only thing it ever writes to the log.

Under contention a release is still written, but **once per handoff rather than once per
acquisition** — 0.023–0.054 entries per section, one release per 19 to 43 sections. That ratio is the
amortization, measured.

The same column separates the fairness regimes. Where the releases are spread across nodes (run 1,
327/262) the key is genuinely circulating; where they are all on one node (runs 2 and 3) that node
surrendered ~597 times and took it straight back, and those releases bought the asking node one
section between them.

A `lockRelease` measures 54 B of stored value here against the baseline's 69–70 B, but the two runs
use different key strings and the payload is `[key, requester, epoch, incarnation, counter]`
(`core/resources/recordLockCoordinator.ts:220`), so the per-entry widths are not like-for-like. The
load-bearing change is the number of entries, not their size.

## 5. Cost when off

500 unlocked `put`s, one transaction each, in-process, 30 batches per node interleaved round by round
(off, none, on, off, none, on, …) on three standalone single-worker nodes. Arms as in the baseline:
**off** — replicated database, `replication.recordLocks: false`; **none** — database not replicated,
no transport ever registered; **on** — enabled, lone node, locks never used.

| arm  | n   | ms per 500 puts: min / p50 / p95 / max | puts/s at p50 | probe                                              |
| ---- | --- | -------------------------------------- | ------------- | -------------------------------------------------- |
| off  | 30  | 18.40 / 20.57 / 28.20 / 28.45          | 24 300        | refused, "not enabled on this node", **no status** |
| none | 30  | 18.00 / 20.71 / 27.50 / 30.80          | 24 100        | **503** "no record lock transport is registered"   |
| on   | 30  | 18.03 / 20.35 / 32.25 / 33.11          | 24 600        | lock acquired                                      |

`off − none` at p50, per run: **−0.14, −3.13, −1.16 ms** per 500 puts. Across runs the p50s were
off 19.64–22.07, none 20.71–23.23, on 20.03–21.85.

Indistinguishable, and the direction of the difference is the clearest evidence of it: `off − none`
is **negative in all three runs** — the arm carrying the fail-closed transport measured _faster_ than
the arm with no transport registered at all. That is not a cost the gate could produce. The gap
(0.14–3.13 ms per 500 puts) is also smaller than each arm's own run-to-run movement: `off` alone
ranged 19.64–22.07 ms across the three runs. An earlier set of three runs on the same build gave
+0.39, −0.26 and −1.31 ms, so the sign is not stable across sets either.

**The probe column also turned up a defect, which is the one thing in this document that is not a
cost.** The `off` arm's refusal carries **no `statusCode`** — in all three runs, against the `none`
arm's 503 in all three. `createDisabledRecordLockTransport` raises a plain `Error`
(`replication/recordLockTransport.ts:248`), so the refusal surfaces as a 500, while the `none` arm's
503 comes from core's own error and does carry one. Both that function's own comment and
`replication/DESIGN.md` state the intent as "a 503 naming the switch", and a 500 is not retryable
where a 503 is. The baseline document records 503 for this arm too, which its raw data does not
support either. Not fixed here — this run measures, it does not change the transport — but filed
rather than left in a table cell.

Unlike the baseline, the mechanism is also verifiable in source rather than only in the numbers. The
baseline run found the earlier branch violating §8 here: the commit-time fence scanned every staged
write on every commit, so a bulk transaction in a deployment that never registers a transport paid a
property check per write. That is now latched. `hasLeaseProtectedWrite` is set only where a write
actually carries a lock handle (`core/resources/DatabaseTransaction.ts:1136`), and the pre-submit
fence is guarded on it **in its own loop condition**
(`core/resources/DatabaseTransaction.ts:1409`), so a transaction with no locked write does not enter
the loop at all — zero iterations, rather than one cheap iteration per write. §8's "ordinary writes
keep their existing ungated path, with no exception" is met by construction, and the measurement is
consistent with it.

## 6. Delegation re-acquisition rate

§10 asks for the re-acquisition rate at candidate lease durations, because steady-state cost is
bounded below by a delegation lapsing without contention.

`DELEGATION_LEASE_MS` is 360 s by decision and is a module constant with no override, so it is not
varied here. What is varied is the caller's own lock lease, which moves the same boundary: a lock
asking for `lease` is served from a live delegation only while at least that much of the delegation
is left (`core/resources/recordLockCoordinator.ts:930`), so the **local-serve window is
`DELEGATION_LEASE_MS − lease`**. Two leases give two windows, and a fixed access cadence runs against
each.

Telling a lapse from a local serve is where this measurement is easy to get wrong, and it was got
wrong twice before this run. Two things are required:

- **The key is homed on another node**, so a re-acquisition is a real RPC and not a function call.
- **The tick measures a difference, not a latency.** Each tick locks three times: a separate,
  permanently delegated key to absorb the 0.1–0.25 ms a request pays for its first lock whatever it
  does; then the measured key; then the measured key _again_. The third lock cannot have lapsed — the
  second either renewed the delegation or found it live — so it is a local serve on the same key in
  the same request microseconds later, and the difference between the two is what the second lock did
  beyond serving locally.

Comparing absolute latency against a cut does not work, and it fails in a way that hides itself: the
warm local tail reaches past measurement 1's cheapest remote-home lock, so ticks of 0.20–0.27 ms were
classified as lapses at elapsed times the window says must still be local — and because the
"served locally" population was then reported as _the samples under the cut_, its maximum was bounded
by the cut and the overlap was invisible. The local reference is now reported from every tick's third
lock, independent of any classification.

| run | lease | window | ticks | lapses | at a window multiple | rate  | `cadence / window` | lapsed at (s)          |
| --- | ----- | ------ | ----- | ------ | -------------------- | ----- | ------------------ | ---------------------- |
| 1   | 300 s | 60 s   | 36    | 3      | **3**                | 0.083 | 0.083              | 60, 120, 180           |
| 2   | 300 s | 60 s   | 36    | 3      | **3**                | 0.083 | 0.083              | 60, 120, 180           |
| 3   | 300 s | 60 s   | 36    | 3      | **3**                | 0.083 | 0.083              | 60, 120, 180           |
| 1   | 240 s | 120 s  | 52    | 3      | 2                    | 0.058 | 0.042              | 120, _145_, 240        |
| 2   | 240 s | 120 s  | 52    | 3      | 2                    | 0.058 | 0.042              | _100_, 120, 240        |
| 3   | 240 s | 120 s  | 52    | 4      | 2                    | 0.077 | 0.042              | _100_, 120, _185_, 240 |

Cadence 5 s throughout. Italic times are lapses that are **not** at a multiple of the window. The two
populations, run 1:

| ms                                  | n   | min   | p50  | p95  | p99  | max  | mean |
| ----------------------------------- | --- | ----- | ---- | ---- | ---- | ---- | ---- |
| local reference, every tick (300 s) | 36  | 0.01  | 0.05 | 0.11 | 0.12 | 0.12 | 0.05 |
| delta, served locally (300 s)       | 33  | −0.01 | 0.03 | 0.10 | 0.12 | 0.12 | 0.04 |
| delta, lapsed (300 s)               | 3   | 0.79  | 1.26 | 1.36 | 1.36 | 1.36 | 1.14 |
| local reference, every tick (240 s) | 52  | 0.01  | 0.05 | 0.10 | 0.13 | 0.13 | 0.05 |
| delta, served locally (240 s)       | 49  | 0     | 0.02 | 0.06 | 0.14 | 0.14 | 0.03 |
| delta, lapsed (240 s)               | 3   | 0.35  | 0.51 | 1.28 | 1.28 | 1.28 | 0.71 |

The cut is 0.15 ms. It separates cleanly: the largest served-locally delta is 0.14 ms and the
smallest lapsed delta is 0.35 ms, with the local reference — measured on every tick, independent of
any classification — topping out at 0.13 ms.

**At the 60 s window the prediction is exact, in all three runs.** Three lapses in 36 ticks, at 60 s,
120 s and 180 s, every one of them on a window multiple: `0.0833` measured against `0.0833` predicted.

**At the 120 s window there is one extra lapse per run that the lease does not explain.** Two of the
three or four land on the window (120 s, 240 s); the rest fall at 100 s, 145 s and 185 s, and they are
real rounds by the delta measure (0.35 ms and up), not marginal classifications. Something other than
lease expiry is occasionally dropping a delegation. `#liveDelegation` also discards a delegation whose
token is from a superseded epoch, which is the obvious candidate and is not investigated here.
**It should be understood before a lease value is argued from these numbers**; it inflates the 120 s
row's rate from the predicted 0.042 to 0.058–0.077.

**The rate law.** A delegation is renewed in full on re-acquisition, so for a key accessed every
`gap` with a local-serve window `W`:

```
re-acquisition rate ≈ gap / W,    W = DELEGATION_LEASE_MS − lease
```

which is what both rows measure, and which is the form the answer takes for the shipped 360 s
delegation: with the default 30 s lock lease the window is 330 s, so a key touched every `gap`
seconds pays a round on `gap / 330` of its locks — 1 lock in 330 at a 1 s cadence, 1 in 33 at 10 s,
1 in 5.5 at 60 s. A key idle longer than the window pays a round every time, which is measurement
1's remote-home figure and not measurement 2's.

**What a lapse costs**, from the table: 0.35–1.36 ms above a local serve, the same single round trip
as a first lock, because that is what it is. So a delegated key's steady-state cost is

```
amortized ≈ 0.02 ms + (gap / 330 s) × 1.0 ms
```

— about **0.05 ms at a 10 s access cadence**, against the baseline's 0.68 ms for every lock. The
lease is load-bearing in the direction §10 says, and at 360 s it is long enough that re-acquisition
is not the dominant term for any cadence under a minute. The 120 s row's unexplained extra lapses are
the caveat on that conclusion: if whatever causes them also fires at the shipped lease, the
`gap / 330` term is a floor rather than the whole cost.

**Delegation retention, for harper#2581.** After 120 distinct keys per node, every node held exactly
**121 delegations** in all three runs — one per distinct key it locked, retained after unlock, and
released only on recall or expiry. That is the sizing rule: the resident set is _distinct keys
touched per lease window_, not locks in flight. The caps are
`MAX_DELEGATIONS_PER_TABLE = 10 000` and `MAX_DELEGATIONS_PER_REQUESTER = 2 000`
(`core/resources/recordLockCoordinator.ts:67`), and they are per table, which is what harper#2581
says makes the process-wide bound scale with table count.

## Not measured, and why

- **Cold-key throughput and backlog sensitivity on the recovery path** — §10's own row, and the one
  that can dominate. **Unmeasurable today, and not for want of a harness:** the path does not exist.
  `core/resources/recordLockCoordinator.ts:43` records that the successor-freshness fence of §7 — the
  inherited `(origin → position)` dependency set on the release entry, and the recovery barrier — is
  deliberately not implemented, and names harper#2542 as the work. There is no barrier to time, no
  position query to count, and no backlog to be sensitive to. The row stays empty on purpose; it is
  not an omission from this run. Measurement 3 shows what its absence costs on the _hot_ path.
- **Epoch renewal cost.** The epoch on this branch is static scaffolding — one `LockEpoch` derived
  from the replication group, never advanced — so there is no renewal to cost. That is
  harper-pro#825's protocol, and it is the real enablement gate.
- **Allocation rate on the cached-delegation path.** §8's requirement is _zero additional protocol
  allocation_ on a delegation hit, against a Phase 0 baseline that already allocates a handle and a
  promise. Nothing here counts allocations; the repeat-lock latency in (2) is the observable this run
  offers for that path, and it is consistent with the requirement without proving it.
- **Cap saturation behavior.** `MAX_DELEGATIONS_PER_TABLE` is 10 000 and
  `MAX_DELEGATIONS_PER_REQUESTER` 2 000 (`core/resources/recordLockCoordinator.ts:67`). The bench
  touches at most a few hundred distinct keys, so no arm approaches either cap and the `capacity`
  rejection path is never taken.
- **Frame deliveries** are still derived from entry counts rather than counted on the wire, for the
  same reason the baseline gave: neither side keeps a per-type receive counter. Under delegations the
  derivation is weaker than it was, because the delegation request and reply are unicast RPC and
  never appear in the log at all — only the release does.
- **Real network latency.** Everything here is loopback on one box. On a real cluster the home round
  trip in (1) and the handoff in (3) are bounded below by the participants' actual round trip, and
  the repeat-lock figure in (2) is the one number that does _not_ move, because it never leaves the
  process. That asymmetry is the whole point of the protocol, and it means the gain measured here is
  a lower bound on the gain a real cluster would see.
