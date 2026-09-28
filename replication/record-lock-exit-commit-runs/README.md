# Raw output for the exit-commit probe

One file per run of `npm run probe:record-lock-exit-commit`, written to `RECORD_LOCK_EXIT_OUT`.
Measured on harper-pro#865's branch, machine class as stated in `RECORD_LOCK_RELAY_TRANSPORT.md`.

| file                     | command                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| `exit-commit-run-1.json` | `AWAIT_TERMINATE=0 RECORD_LOCK_EXIT_OUT=… npm run probe:record-lock-exit-commit` |

`AWAIT_TERMINATE=0` is the interesting arm: awaiting `worker.terminate()` would let the runtime
drain the doomed thread before the successor starts, which is the assumption under test.
