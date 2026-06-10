# YCSB cluster load test (harper-pro)

The 3-node cluster variant of the [core YCSB load test](../../core/benchmarks/ycsb/README.md).
It reuses the core workload generator, REST transport, and harness
(`core/benchmarks/ycsb/`) and adds the cluster lifecycle: it starts N connected
Harper Pro nodes (default 3, `threads.count=4` each) with the `usertable` app
pre-installed, connects them, then drives the YCSB load + run phases **round-robin
across all nodes** over REST — so writes land on different nodes and propagate via
cluster replication.

## Running

```sh
npm run build            # build the Pro distribution (dist/bin/harper.js)
node benchmarks/ycsb/run-cluster.mts --scale=standard
node benchmarks/ycsb/run-cluster.mts --scale=quick --nodes=3
```

To run against an already-built distribution elsewhere, set
`HARPER_INTEGRATION_TEST_INSTALL_SCRIPT` to its `dist/bin/harper.js`.

All core flags apply (see the core README). Cluster-specific defaults:

- `--nodes` (default 3) — cluster size.
- `--settle-ms` (default 10000) — wait after the load phase for asynchronous
  replication to converge before the read/run phase.
- `--workloads` (default `C,B,A,F,E`) — see the caveat below.

## Round-robin + asynchronous replication

Because reads round-robin across nodes and replication is asynchronous, a read
can land on a node that has not yet received a very recent write. The defaults
account for this:

- The loaded dataset is given `--settle-ms` to converge before any reads, so
  C/B/A/F/E run cleanly (their reads/scans target the converged dataset; updates
  replicate asynchronously but a read still returns a valid — possibly slightly
  stale — record, not an error).
- **Workload D** (read-latest-after-insert) is *excluded by default*. Under
  round-robin it is dominated by replication lag — its "latest" reads target keys
  just inserted on another node that often have not replicated yet, surfacing as
  read errors. Run it explicitly with `--workloads=D` to observe replication lag,
  interpreting the errors as not-yet-replicated reads rather than failures.

Results are written to `core/benchmarks/ycsb/results/` (git-ignored) as
`ycsb-cluster-<timestamp>.json`.
