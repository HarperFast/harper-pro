# Memory-limit miss curve

Measures how much extra disk I/O and request latency one Harper Pro instance incurs as its container memory limit shrinks, on throwaway GCP VMs shaped like the most common Fabric production host. One command creates the VMs, runs the matrix, fetches the results, deletes every cloud resource, and writes `report.md`.

```sh
node benchmarks/memory-curve/run.mts --project <gcp-project> --profile smoke   # ~1 h, one small pair
node benchmarks/memory-curve/run.mts --project <gcp-project>                   # full matrix, ~20 h
```

Requirements on the machine running it: Node 24+, `gcloud` with permission to create instances, disks and firewall rules in the project (`roles/compute.instanceAdmin.v1`, `roles/compute.securityAdmin`, `roles/iam.serviceAccountUser`), `ssh`/`scp`, and a committed checkout: the VMs build and run `HEAD`, including the `core` submodule.

## What runs where

```
local: run.mts ── gcloud ──▶ firewall rules + per pair: server VM, client VM
                 └─ ssh ──▶ server-setup.sh (data disk, Docker, image build from HEAD)
                           client-setup.sh  (Node) → orchestrate.mts (detached)
client VM: orchestrate.mts ── HTTP :9926 ──▶ Harper container on server VM
                           └─ ssh ─▶ server-ctl.sh (start/stop/restore, counters)
```

- **Server VM**: `n2d-highmem-4`, Ubuntu 22.04, 64 GB `pd-ssd` boot disk, 400 GB `pd-balanced` data disk (XFS), the shape of most Fabric GCP hosts. Harper runs in a container built from this checkout's `Dockerfile`, with host networking and the environment host-manager gives a Level-2 colocated instance: 4 CPUs, `threads.count` 8, `THREADS_MAXHEAPMEMORY` 2000, block cache 15% and write-buffer manager 5% of the memory limit (cost-to-cache on, stalls off), `memory.high` at 5/6 of `memory.max` (host-manager uses limit − 1 GB, which is 5/6 at 6 GB), no swap, read-IOPS cap 20,000. Plain HTTP on 9926; the operations API on 9925.
- **Client VM**: `n2d-standard-8` running the orchestrator and the load generator (one worker thread per vCPU but one).
- **Firewall**: one rule allows tcp 22/9925/9926 from this run's client tag to its server tag; one allows SSH from the launcher's public IP only. Each server gets a random admin password.

## Matrix (`matrix.mts`)

| profile | pairs                        | records                                                                                        | per pair                                                                                                                                                                                     |
| ------- | ---------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full`  | `d1x-1k`, `d2x-1k`, `d4x-1k` | 10 × 100 B fields; data ≈ 1×, 2×, 4× the 6 GB starting limit                                   | workloads C (100% read) and B (95/5 read/update) × skew uniform, Zipf 0.8, 1.0, 1.2 × memory steps 100, 70, 50, 35, 25% + 50% with the block cache pinned to the 100% size; two repeat cells |
| `full`  | `d2x-4k`                     | 10 × 400 B fields (values ≥ 2 KB go to RocksDB blob files, outside the block cache); data ≈ 2× | C and B × Zipf 1.0 × the five steps                                                                                                                                                          |
| `smoke` | `smoke`                      | 10 × 100 B; data ≈ 0.25×                                                                       | C and B × Zipf 1.0 × 100%, 25%, 50% pinned; 1-minute windows                                                                                                                                 |

Memory steps are fractions of `memory.max` = 6 GB (a Level-2 instance: 4 GB nominal + 2 GB headroom). Each pair runs on its own VMs, all pairs in parallel.

Per pair: fio on the data disk (4 KiB random reads, QD 1 and QD 256) → load all records over REST → wait for compaction → snapshot the data directory (XFS reflink). Then, for every calibration and every cell: restore the snapshot, drop the page cache, start Harper under the cell's policy.

- **Calibration** (per workload and skew): closed loop, no memory limit, the SST and blob files read into the page cache first, then 2 minutes warm-up + 2 measured; the in-memory maximum rate.
- **Cell**: open loop at 50% of that maximum; 10 minutes warm-up, then 10 minutes measured.

## Measurements

Per cell, over the measured window:

| source                       | values                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| client                       | offered and completed rate; p50/p99/p99.9 latency measured from each request's scheduled send time (no coordinated omission); shed (in-flight cap reached), timeouts (10 s), errors; schedule lag; client CPU                                                                                                     |
| `/proc/diskstats`, data disk | reads/s, read bytes/s, mean read latency (time in queue + device ÷ reads; unavailable when there are no reads), writes, utilization                                                                                                                                                                               |
| container cgroup             | `io.stat` reads on the data disk and on every device (the boot disk holds the image, whose code pages are read back when the page cache is squeezed), `memory.stat` major faults/s and file/anon bytes, `memory.events`, `cpu.stat` (CPU per request), `memory.pressure` / `io.pressure` / `cpu.pressure` stall % |
| Harper `system_information`  | RocksDB block-cache hit rate, overall and data blocks, for the `data` database                                                                                                                                                                                                                                    |

A cell is **invalid** if the container restarted or was OOM-killed, a counter went backwards, or more than 0.1% of requests failed with errors. It is **saturated** (kept, flagged ⚠) if more than 0.1% of requests were shed or timed out, or under 99% of the offered rate completed; latency percentiles then cover completed requests only. Counters are also taken at the middle of the window, so drift between halves is visible in the cell JSON.

## Commands and options

| command                 | does                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `run` (default)         | create → provision → run → fetch → delete → report                           |
| `resume --run-id <id>`  | re-attach to a run whose launcher died; then fetch, delete, report           |
| `status --run-id <id>`  | print each pair's progress                                                   |
| `cleanup --run-id <id>` | delete the run's instances, disks and firewall rules, and verify none remain |
| `report --run-id <id>`  | rebuild `report.md` and the SVG charts from fetched results                  |

| option                                                                     | default                           |                                                                                                                  |
| -------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--project`                                                                | `$MEMORY_CURVE_PROJECT`           | GCP project                                                                                                      |
| `--zone`                                                                   | `us-central1-a`                   |                                                                                                                  |
| `--profile`                                                                | `full`                            | `full` or `smoke`                                                                                                |
| `--pairs`                                                                  | all                               | comma list of pair names                                                                                         |
| `--run-id`                                                                 | `mc<yymmddhhmm>`                  | lowercase letters and digits; prefixes every resource name (`mc-<id>-…`)                                         |
| `--max-run-hours`                                                          | 46                                | each VM deletes itself (with its disks) after this, even if the launcher is gone                                 |
| `--keep`                                                                   | off                               | leave the resources up (debugging); delete later with `cleanup`                                                  |
| `--adc`                                                                    | off                               | authenticate gcloud calls with application-default credentials, for a gcloud login that needs interactive reauth |
| `--ssh-source`                                                             | detected public IP /32            | source range for the SSH rule                                                                                    |
| `--server-machine`, `--client-machine`                                     | `n2d-highmem-4`, `n2d-standard-8` |                                                                                                                  |
| `--boot-disk-type`, `--boot-disk-gb`, `--data-disk-type`, `--data-disk-gb` | `pd-ssd`, 64, `pd-balanced`, 400  | disk performance scales with size; keep production sizes                                                         |
| `--poll-minutes`                                                           | 10                                |                                                                                                                  |
| `--allow-dirty`                                                            | off                               | run with uncommitted changes (they are not on the VMs)                                                           |
| `--dry-run`                                                                | off                               | print the plan and time estimate only                                                                            |

Outputs go to `benchmarks/memory-curve/runs/<run-id>/` (git-ignored): `manifest.json` (every resource name, written before it is created), `<pair>/` (raw results: `fio.json`, `dataset.json`, `calibration/*.json`, `cells/*.json`, `orchestrate.log`, `SHA256SUMS`, verified after fetching), `report.md`, `chart-<workload>.svg`. A pair that did not finish is copied to `<pair>-partial/` before cleanup.

## Report definitions (`report.mts`)

- **memory / data**: the cell's `memory.max` over the on-disk dataset (SST + blob files after load and compaction).
- **reads per 1k**: data-disk reads per completed request × 1000, i.e. reads/s per 1,000 req/s. **Extra** subtracts the same figure from the unconstrained calibration of that workload and skew.
- **p99 knee**: the largest memory step whose p99 is at least 2× the lowest p99 in its series, or that saturated (including one that completed no request).
- **saturated cells** show the share of the offered rate served instead of reads: their reads are those of a server that stopped keeping up. Slopes skip them, and charts draw them as a cross on the top edge.
- **reads per GB removed**: the change in extra reads per 1k between adjacent unsaturated steps divided by the memory removed, tagged with data / (mean memory of the two steps).
- **pinned share**: the fraction of the 100% → 50% increase in extra reads that pinning the block cache at its 100% size removes, i.e. the block cache's part of the loss, with the page cache's part as the remainder.

## What it does not represent

- Real key popularity: production access is not a stationary Zipf over one table.
- Scans, secondary-index reads, multi-table transactions and large blobs.
- Write amplification from compaction at production write rates (workload B updates 5% of requests only).
- TLS (production terminates TLS on 9926), authentication other than cached Basic auth, and multi-tenant neighbours on a shared host.
- Record contents: random-character values (about 20% compression on disk); real JSON compresses more, which shifts how much the page cache holds compared with the block cache.

## Tests

```sh
node --test benchmarks/memory-curve/*.test.mts
```
