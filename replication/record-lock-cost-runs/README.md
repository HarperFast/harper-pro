# Raw bench output for RECORD_LOCK_COST_DELEGATIONS.md

One file per run of `npm run bench:record-locks`, written by the bench to `RECORD_LOCK_BENCH_OUT`.
Measured on harper-pro#822's branch with `core` at the harper#2498 head, machine class as stated in
the results document.

| file                                    | command                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `delegations-run-1.json`                | `RECORD_LOCK_BENCH_OUT=… npm run bench:record-locks`                                |
| `delegations-run-2.json`                | as above                                                                            |
| `delegations-run-3.json`                | as above                                                                            |
| `delegations-run-4-starvation-40s.json` | as above with `RECORD_LOCK_BENCH_HOT_KEY_MS=40000 RECORD_LOCK_BENCH_REACQ_RUN_MS=1` |

Runs 1–3 are the three the document reports distributions and spread from. Run 4 exists only to take
the hot-key round past `DEFAULT_LOCK_TIMEOUT_MS` (30 s), which is what turns the starved contender's
wait into a 423; its measurement-6 numbers are deliberately truncated and should not be read.

All four were produced by the bench as committed. One exception: with both leases in
`REACQUISITION_LEASES_MS` (300 s, 240 s) and `RECORD_LOCK_BENCH_REACQ_RUN_MS=1`, measurement 6 should
save one `reacquisition` entry per lease — `delegations-run-4-starvation-40s.json` has only the first
(300 s / 60 s window). The exact environment for that run was not recorded closely enough to say
whether the second lease's iteration threw, and this is consistent with the "should not be read"
caveat above rather than a contradiction of it.
