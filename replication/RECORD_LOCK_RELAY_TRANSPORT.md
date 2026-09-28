# The off-owner admission relay: what it costs, and what shared state would buy (harper-pro#852)

At `threads.count = N` one worker coordinates a database and the other `N-1` relay every `lock()` to
it (`replication/DESIGN.md`, the owner-relay bullet). So `(N-1)/N` of locks pay a thread round trip
that an on-owner lock does not — and on Linux the default `threads.count` is one less than the
logical CPU count (`core/validation/configValidator.ts`), so that is 18 of 19 locks on this
20-thread box. macOS and Windows default to 1 worker and never reach this path. This records what
that round trip actually costs, whether `rocksdb-js`'s `notify()` or its cross-thread shared buffers
can remove it, and why the answer is "not inside this PR".

```
npm run bench:record-lock-relay
```

`benchmarks/recordLockRelay/transport.bench.mjs` — one process, one extra worker, no cluster. Raw
output for the three runs below is in `record-lock-relay-runs/`.

## Results

Same machine class as `RECORD_LOCK_COST_BASELINE.md`: 12th Gen Intel i7-12700H (20 threads), 31 GiB,
Linux x64, Node v26.2.0. 3 000 samples per row.

Every figure below is `transport-run-1.json` as committed; the spread is over all three runs.

| ms                                        | p50    | p95    | max   |
| ----------------------------------------- | ------ | ------ | ----- |
| A&nbsp; postMessage round trip (today)    | 0.0164 | 0.0209 | 0.51  |
| A′ same, owner busy 0.25 ms/turn          | 0.259  | 0.261  | 0.44  |
| A′ same, owner busy 1 ms/turn             | 1.008  | 1.058  | 1.93  |
| B&nbsp; `notify()` round trip             | 0.0179 | 0.0193 | 0.19  |
| B′ same, owner busy 0.25 ms/turn          | 0.259  | 0.262  | 0.45  |
| B′ same, owner busy 1 ms/turn             | 1.011  | 1.020  | 1.61  |
| C&nbsp; `getUserSharedBuffer` + `Atomics` | 0.0038 | 0.0090 | 0.38  |
| C2 the same, slot handle cached           | 0.0002 | 0.0002 | 0.015 |
| D&nbsp; `tryLock` + `unlock`              | 0.0022 | 0.0026 | 0.048 |
| E&nbsp; on-owner admission (JS maps)      | 0.0003 | 0.0005 | 0.054 |

Run-to-run p50 spread over the three runs is **at most 3.5%** (row E; every loaded row is under
0.3%). Rows C, C2 and E involve no other thread; rows A, A′, B and B′ do. The maxima are single
samples on a shared box and should be read as noise, not as a tail characterisation.

Rows C and C2 measure the **admit** path, not the reject path: a fresh shared buffer is zeroed, and
a zeroed slot reads as generation 0 with an elapsed expiry, so the check short-circuits before
either atomic write. The bench seeds the slot as a live delegation and then asserts that the
admission counter advanced once per sample, which fails the run outright rather than reporting a
reject's timing as an admission's.

### 1. `notify()` is not faster than `postMessage`, at any load

0.0179 ms against 0.0164 ms idle, and the two **agree to 0.3%** under owner load (1.011 against
1.008 at 1 ms/turn). That answers the
question this thread opened with: `notify()` is an excellent transport, but the relay's cost is not
transport cost, so swapping transports buys nothing. Nothing here argues against `notify()` for the
home-map and owner-change broadcasts, where it is a fit on other grounds.

### 2. The relay's real cost is the owner's event loop, not the message

A relayed acquire is answered from the coordinating worker's event loop, so it cannot be answered
before that worker's current turn ends. Idle, that is 16 µs. Busy — which is the normal state of a
worker at `threads.count > 1`, since the coordinator also serves its own requests — it is the turn
length:

| owner's per-turn work | off-owner `lock()` p50 |
| --------------------- | ---------------------- |
| idle                  | 0.0164 ms              |
| 0.25 ms               | 0.259 ms               |
| 1 ms                  | 1.008 ms               |

The last row is the number that matters. `RECORD_LOCK_COST_BASELINE.md` §2 measured the **pre-delegation**
cluster round trip at 0.68 ms per lock, and `RECORD_LOCK_COST_DELEGATIONS.md` §2 measured the
delegation protocol collapsing it to 0.01–0.03 ms. A coordinating worker doing 1 ms of work per turn
puts an off-owner lock back **above the cluster round trip the delegation protocol was built to
remove** — for `(N-1)/N` of locks. The relay is correct and uniform, which is what #852 set out to
buy; it is not cheap, and it is not cheap in a way that scales with how busy the owner is rather
than with anything the lock does.

This is also head-of-line blocking, not just latency: every off-owner lock for every database that
worker coordinates queues behind the same turn.

### 3. A local admission against shared state would cost 0.0002 ms

Row C2 is the whole hot-path check — not recalled, generation current, enough lease left — plus the
admission mint (two sequentially-consistent read-modify-writes), against a `getUserSharedBuffer`
slot. It is 0.0002 ms, it does not wait on another thread, and **it does not move when the owner is
busy**, because nothing about it involves the owner. Against row A′ at 1 ms/turn that is a factor of
5 000, and against the on-owner floor (row E, 0.0003 ms) it is at parity — which is the actual goal:
an off-owner lock costing what an on-owner lock costs.

Row C is the same check with `getUserSharedBuffer` called per acquire: 0.0038 ms, still 260× better
than a loaded relay, and the gap to C2 is the native call and key encoding, not the atomics. So a
per-key slot handle has to be cached on the calling worker for the full win, which is ordinary work
but is work.

## Why this is not the change to make in #865

The measurement says the shared-state path is worth having. Three things say it is a follow-up on
top of a landed relay, not a replacement for it.

**The fence cannot use the native key lock, so the relay's message machinery survives in full.**
A recall must stop a delegate from _committing_, not merely from admitting: a caller that staged a
write and then called `unlock()` has given the native key back, and its write is still in its
transaction (`core/resources/recordLock.ts` `revokeLease()`, and the `Delegation.admissions` comment
in `recordLockCoordinator.ts` — §6 revokes capability, not admission). The thing a fence sets is
`handle.expired`, a field in the calling worker's own isolate that no other thread can reach. So the
owner must still send a revoke to the holding thread and still wait for its ack before it writes
`lockRelease` — which is `revokeRemoteHandle`, `handleRevokeAck`, the origin authentication, the
ownership generation, `fenceRelayedAdmissionsForDatabase` and the handoff protocol, unchanged. Only
the acquire and release halves could go.

**A delegation that is not yet installed still needs the owner.** The shared slot can answer "there
is a live delegation for this key" without a round trip. It cannot _obtain_ one — that is a cluster
request, and it belongs on the coordinating thread. So `acquireOnOwnerRelay` remains as the slow
path, and the two paths coexist rather than one replacing the other. **Net: this adds a fast path,
it does not remove a mechanism.** It is a performance change, not a simplification, and it should be
proposed as one.

**The hot-path protocol is lock-free and has to be exactly right.** The caller reads the slot while
holding the native key lock; the owner marks `recalled` on a recall, and it cannot take that key lock
to do it (a recall must not block behind a live critical section). That is a store-buffer
handshake — the caller sets its holder bit then reads `recalled`, the owner sets `recalled` then
reads the holder mask, both sequentially consistent — and a missed interleaving admits a caller the
owner's fence sweep never sees. Seq-cst `Atomics` give the ordering; getting the protocol right is
still the work. Doing it _underneath_ a relay that already passes the correctness suites, as a fast
path that falls back, is a much better position than doing it instead of one.

It is also a **core** change: `LockCoordinator.acquire` decides off-owner before it ever looks for a
live delegation (`recordLockCoordinator.ts`, the `ownsCoordination()` branch precedes
`#liveDelegation`), so the fast path has to be taken there. harper-pro only supplies the transport.
That makes it a second coordinated harper + harper-pro pair, on top of #865 and harper#2667.

## Sketch, for the follow-up

Per (database, table, key), a `getUserSharedBuffer` slot the owner writes and any worker reads:
generation, token counter, delegation expiry, a `recalled` flag, an admission-id counter, a holder
mask. `getUserSharedBuffer` is itself keyed, so `rocksdb-js` does the per-key addressing and there is
no shared-memory allocator to write; a slot is freed when the last reference to it is collected.

- **Admit:** under the native key lock the caller reads the slot; live and not recalled with enough
  lease left → mint an id from the shared counter, set its holder bit, admit locally with a local
  revoker. No message. Miss → today's relay.
- **Release:** local; the holder bit clears when the worker's last admission for the key ends.
- **Recall:** the owner sets `recalled`, reads the holder mask, and fences exactly those workers over
  the existing revoke/ack path. Cold, and the mask is what keeps the fan-out off idle workers.
- **Exit:** a worker that dies leaves a holder bit set; the delegation's own lease bounds it, the same
  backstop `onThreadExit` already relies on.

## Engine

The bench opens a `RocksDatabase` because v5 opens its record stores on `@harperfast/rocksdb-js`
(`core/resources/databases.ts`, `auditStore.ts`) and the native key lock these locks already take is
that engine's. The two results are not equally portable, and the difference points the same way as
the verdict above: `lmdb` exposes `tryLock`, `unlock` and `getUserSharedBuffer`, so the shared-slot
fast path is an engine-agnostic design, while it has **no** `notify` — a `notify()`-based transport
would have been the RocksDB-only one. Probed directly on the installed `lmdb`, not inferred.

## Byproduct: what this says about exit-counts-as-fenced (ledger item 5)

The argument above — a handle is revoked _after_ `unlock()` has returned the native key — also
removes a narrowing that the PR's ledger item 5 was resting on. That item counts a worker's **exit**
as a completed fence on the ownerless-handoff path, justified by the process-wide native key lock.
If the key is already free while a staged write is still in flight, the residual window is not
"teardown released the key early"; it is any commit in flight when the worker exits, with no
misordering required. A review round re-ruled the item to major on exactly that reading, so it is
probed here rather than left as an inference.

```
npm run probe:record-lock-exit-commit
```

`benchmarks/recordLockExitCommit/` terminates a worker that has handed writes to the engine and
never awaited them, then has a successor write the same keys. Raw output in
`record-lock-exit-commit-runs/`. 5 trials per mode, 4 000 contested keys of 128 KiB each, started
**without** awaiting `worker.terminate()` (awaiting it would let the runtime drain the thread
first, which is the assumption under test):

| question                                                            | result              |
| ------------------------------------------------------------------- | ------------------- |
| Does an abandoned commit still land after its thread is terminated? | **40 000 / 40 000** |
| Can it land _after_ a successor's write to the same key?            | **0 / 40 000**      |

Both halves matter, and they point opposite ways. A commit handed to the engine is **not** cancelled
by its thread's death — so exit-as-fenced is not backed by the engine discarding abandoned work, and
anyone reasoning that way is wrong. But the writes land in **submission order**, so a successor
admitted after the exit cannot have its write overwritten by the departed worker's, which is the
lost update the concern names. Identical for `put` and `transaction`.

This narrows the open question rather than closing it. What is left for the storage owner
(rocksdb-js#865) is no longer "can a commit outlive its thread" — it can — but "is that submission
ordering guaranteed across threads and across separate `RocksDatabase` handles on one path, or is it
an artefact of one write queue on this build". That is a far sharper question than the item has
carried so far, and it is the one worth asking. Nothing here licenses relaxing the fence.

## Not measured, and why

- **Contention on one slot.** Callers for the same key serialize on the native key lock already, so
  the slot is uncontended by construction for the admit path. The owner's recall write is the one
  concurrent writer, and it is cold.
- **Real load rather than a spin loop.** Rows A′/B′ use a fixed per-turn spin because the point is the
  relationship between turn length and relay latency, which a real workload would only add noise to.
  The 0.25 ms row is the realistic one for a worker serving HTTP; 1 ms is a busy one, not a pathological
  one.
- **Whether the follow-up is worth its complexity.** That is a judgement on top of these numbers, not
  a number. What the numbers settle is that the cost is real, that it grows with owner load, and that
  `notify()` is not the fix.
