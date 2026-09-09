# Cluster record locks: cost baseline (Ricart–Agrawala, harper-pro#822)

The before-figures the replacement protocol (harper `docs/record-lock-ownership.md` §10) has to beat.
Numbers, not tuning: nothing in the lock protocol was changed to produce them.

```
npm run bench:record-locks
```

`integrationTests/cluster/recordLockCost.bench.mjs` boots the same 3-node full mesh
`recordLockCluster.test.mjs` proves correct (`threads.count: 1`, `replication.recordLocks: true`),
then three standalone nodes for the disabled arms. Timing is taken inside the nodes
(`fixture-record-lock-bench`), so the distributions are the lock machinery's, not the HTTP client's. The
raw results of every run land in a JSON file (`RECORD_LOCK_BENCH_OUT`). Not part of
`test:integration:cluster`: it measures, it does not gate.

**Machine class for the figures below:** one laptop, 12th Gen Intel i7-12700H (20 threads), 31 GiB,
Linux x64, Node v26.2.0, every node on its own loopback address — so the network round trip is
microseconds and every figure is a lower bound on what a real cluster pays. Three nodes plus the
client share the box; the run-to-run spread noted under each measurement is that sharing.

## 1. Uncontended acquisition latency

`table.lock(id, { hold: true })` on distinct keys, 120 acquisitions per node, each node requesting in
turn while the other two only grant. Acquire = request written durably + both grants applied.

| ms      | n   | min  | p50  | p95  | p99  | max  | mean |
| ------- | --- | ---- | ---- | ---- | ---- | ---- | ---- |
| acquire | 360 | 0.60 | 1.03 | 2.01 | 2.34 | 3.05 | 1.13 |
| release | 360 | 0.05 | 0.07 | 0.15 | 0.19 | 0.34 | 0.09 |

Per requester the p50 ranged 0.76–1.32 ms across the three nodes (the first-started node is the
slowest, consistently across runs). Across three full runs the pooled p50 was 1.03–1.45 ms.

## 2. Repeat-lock latency

One node locking the same key 200 times back to back. Today this is a full cluster round every time.

| ms      | n   | min  | p50  | p95  | p99  | max   | mean |
| ------- | --- | ---- | ---- | ---- | ---- | ----- | ---- |
| acquire | 200 | 0.47 | 0.65 | 1.41 | 4.44 | 10.26 | 0.86 |

Indistinguishable from (1) once the per-requester spread is taken into account (0.64–1.14 ms p50
across runs; the tail is the same order). This is the figure a per-record delegation is meant to turn
into a local key lock.

## 3. Hot-key handoff throughput

One key; each contending node keeps exactly one `lock → read → increment → save` request in flight for
15 s, the request transaction's commit being the unlock (`LockedIncrement`). Successful critical
sections per second, whole cluster. The counter converged to exactly the section count on every node
in every run (no lost update, no failed round).

| contenders | sections | sections/s | lock p50 / p95 / p99 (ms) | section p50 / p95 (ms) |
| ---------- | -------- | ---------- | ------------------------- | ---------------------- |
| 2 of 3     | 13 372   | 891        | 1.06 / 2.7 / 3.5          | 1.77 / 4.3             |
| 3 of 3     | 14 515   | 968        | 2.01 / 4.5 / 5.6          | 2.68 / 6.0             |

The cluster stays a 3-participant mesh in both rows; "contenders" is how many nodes drive the key.
A second run gave 793 and 750 sections/s for the same rows, so the aggregate rate is **noisy to
about ±15 %** on this box and the 2-vs-3 ordering is not significant. What is stable: per-node lock
latency roughly doubles from 2 to 3 contenders (every acquisition waits for the other two holders'
turns), and the per-section time is lock latency + ~0.7 ms of read/write/commit.

## 4. Transaction-log cost per acquisition

Read from each node's own `Counter` transaction log (`auditStore.getRange`) before and after a fixed
number of acquisitions. Bytes are the stored value per entry; the log key adds 8 bytes each.

Uncontended (120 acquisitions, requester → grantors), per acquisition:

| role               | entries | bytes | by type                                      |
| ------------------ | ------- | ----- | -------------------------------------------- |
| requester          | 2       | 150   | `lockRequest` 81–82 B, `lockRelease` 69–70 B |
| each of 2 grantors | 1       | 80    | `lockGrant` 80–81 B                          |
| **cluster total**  | **4**   | ~310  |                                              |

Under contention (the hot-key runs above), per successful section: 1.5 entries on each of 2
contenders + 1 on the idle node, or 1.33 on each of 3 contenders — again **4 per acquisition**, with
entries 10 B smaller because the shorter key.

Sanity check against the theory for P = 3: P+1 = 4 durable commits per acquisition, matched exactly
(1 request + 2 grants + 1 release). Every entry is sent to the other P−1 nodes, so frame deliveries are
4 × 2 = P²−1 = 8 per acquisition; a received entry is applied and not re-logged, which is why the
per-node counts sum to 4 and not 12.

## 5. Cost when off

500 unlocked `put`s, one transaction each, in-process, 30 batches per node interleaved round by round
(off, none, on, off, none, on, …) on three standalone single-worker nodes:

- **off** — replicated database, `replication.recordLocks: false`: the fail-closed transport is registered (probe: 503 "not enabled on this node").
- **none** — database not replicated: no transport ever registered (probe: 503 "no record lock transport is registered").
- **on** — `replication.recordLocks: true`, lone node, locks never used (probe: lock acquired).

| arm  | n   | ms per 500 puts: min / p50 / p95 / max | puts/s at p50 |
| ---- | --- | -------------------------------------- | ------------- |
| off  | 30  | 17.5 / 19.3 / 23.2 / 31.6              | 25 900        |
| none | 30  | 17.0 / 18.8 / 28.9 / 33.6              | 26 600        |
| on   | 30  | 17.8 / 20.0 / 29.4 / 32.2              | 25 000        |

off − none = +0.5 ms per 500 puts at p50 (+2.6 %) with a batch-to-batch spread of 6–15 ms; the
previous run had the sign reversed (off 22.1, none 23.0, on 23.4 ms). **Inside noise.** That matches
the code: the unlocked write path never consults the transport (`getClusterLockTransport` is reached
only from `lock()` and from the replicated-entry sink), so there is nothing for the gate to cost.

## Caveat that shaped the harness

An earlier version of (3) ran the `lock → increment → unlock` loop in-process with `{ hold: true }`
inside one long request. That loop **loses every peer update**: two nodes each completed 1690
sections in 2 s, each read only its own increments (1, 2, 3, …), and the counter settled at 1690 on
both instead of 3380. A single-node trace shows why: `save()` on a held record inside a request
context commits nothing until the request's transaction ends (the writing node's own GET reads 0 for
the whole 3 s loop, then jumps to the final value), while `unlock()` writes the release — and so
lets the peer's grant through — immediately. The request-transaction path (`LockedIncrement`, the
lock released by the commit that carries the write) converged exactly in every run, so (3) uses that.
Recorded as a finding against the core hold path; the harness does not work around it.

## Not measured, and why

- **Delegation re-acquisition rate, epoch renewal, cold-key/recovery throughput, allocation rate**
  (§10's remaining gate items) belong to the replacement protocol; there is nothing to measure for
  them on this branch.
- **Frame deliveries** are derived from entry counts, not counted on the wire: neither side keeps a
  per-type receive counter, and adding one is product code.
- **Real network latency.** Everything here is loopback on one box. On a real cluster (1) and (2)
  are bounded below by the slowest participant's round trip, and (3) by roughly two of them per
  handoff.
