# YCSB benchmark design notes

## A trend point is published only from a turbo-off host

Invariant: every point on the YCSB cluster trend (gh-pages `dev/bench`) was measured with turbo off and every online CPU's `scaling_max_freq` at its `base_frequency`.

- Why: the bench host is a shared desktop. Its clock state is whatever the last tool left, and a stale `cpupower frequency-set -u 2GHz` cap cut the trend by ~40% from 2026-09-17 with no code change. Turbo off at base clock is a state the runner can set and later undo; a frequency cap is not, because nothing knows what to restore it to.
- Who sets it: `runner/bench-runner-supervisor.sh` turns turbo off while it holds the machine-wide benchmark lock (shared with the host's local `bench-run`) and back on afterwards. A poll pass restores turbo when the lock is free, so a killed holder leaves it off for one poll interval.
- Where it is enforced: the nightly does not trust the supervisor. `check-cpu-pinned.mts` reads sysfs inside the job and its `pinned` output gates both Track steps in `.github/workflows/ycsb-cluster-nightly.yml`, next to the result-completeness gate (`validate-benchmark-json.mts`). An unpinned run still uploads its results and `cpu-state.json`.
- Not covered: harper's own `perf-benchmarks-nightly` runs turbo-off on the same host but has no publish guard. The host's local `bench-run` does not yet remove a `bench-supervisor.drain` container left by a SIGKILLed supervisor before it starts, so it can overlap that orphaned job.
