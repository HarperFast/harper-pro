# Self-hosted bench runner (multi-repo, serial JIT supervisor)

A fixed, sandboxed GitHub Actions runner host for the storage/throughput benchmark
workflows that need consistent hardware to be meaningful — e.g.
[`ycsb-cluster-nightly`](../../../.github/workflows/ycsb-cluster-nightly.yml) here, and
harper core's `perf-benchmarks-nightly`. Shared GitHub runners are too small/variable for
cluster and storage trends, so these run on one fixed machine.

Jobs run in a **Docker container** (filesystem/process isolation), **ephemeral** (one job
per container, then re-registered), **repo-scoped**, and the workflows are
**schedule + manual only — never `pull_request`** so PR code can't execute here.

## Why a supervisor (and not an org-level runner)

The host serves **more than one repo** (`harper-pro` and `harper`). A repo-scoped runner
only serves one repo, and **org/enterprise-level self-hosted runners are not routed jobs
for these repos** — the org's runner groups are inherited from the GitHub Enterprise level,
and an org runner sits idle while a matching job queues indefinitely (verified empirically;
a repo-scoped runner binds the same job in ~15s).

So `bench-runner-supervisor.sh` polls each repo for a queued job targeting the
`harper-bench` label and, when it finds one, registers a throwaway repo-scoped
`--ephemeral` runner that drains exactly that job and exits. Because draining blocks, **at
most one job runs at a time across all repos** — strictly serial by construction, so the
numbers stay comparable and there's no lock to manage.

## Nightly fire order

Four workflows across two repos share the host. Their crons are spaced an hour apart so they
normally fire, and therefore drain, in this order:

| UTC        | Repo       | Workflow                  | Measured run |
| ---------- | ---------- | ------------------------- | ------------ |
| `20 6`     | harper-pro | `stress-large-data`       | 11-26 min    |
| `20 7`     | harper-pro | `ycsb-cluster-nightly`    | 22-30 min    |
| `20 8`     | harper     | `perf-benchmarks-nightly` | 36-39 min    |
| `20 9` Mon | harper     | `large-deploy-test`       | 2-4 min      |

Rows 3 and 4 are set in `HarperFast/harper`, not here. Sized so the whole sequence is off the host before the working day: the last slot ends by
about 10:00 UTC normally, against an 11:00 UTC deadline (05:00 MDT / 04:00 MST). The host is
somebody's desktop, and desktop contention lands in the numbers.

**The order is advisory, not enforced.** Nothing declares a dependency between these
workflows — the spacing just exceeds each job's measured runtime by a wide margin. Three
things can break it, all worth knowing before reading a gap in the trend data as a
regression:

- **A job overrunning its slot.** `drain_one` blocks, and each poll pass checks `harper-pro`
  then `harper`, so harper-pro is favoured only at the _start_ of a pass: a harper job that
  queues while a long harper-pro job is draining is picked up as soon as that drain returns,
  before the loop comes back round to harper-pro. If `stress-large-data` were still running
  when `perf-benchmarks-nightly` fires, the night could drain 1 → 3 → 2 → 4. That needs the
  first slot to take over two hours against a measured ceiling of 26 minutes, so it has not
  been observed.
- **GitHub's scheduler delay, which is unbounded.** On 2026-08-27 every scheduled workflow in
  harper-pro fired about 3 hours late and `ycsb-cluster-nightly` ran until 13:57 UTC. Nothing
  in these crons defends against that.
- **DST.** The crons are UTC and do not follow it. The bound above holds year-round, but local
  times shift: `20 6` is 00:20 MDT and 23:20 MST, so from November through March the first
  slot starts the previous evening, when the desktop is likelier to be in use.

A reordered night still collects every trend point, just out of order. A run can be lost
outright, though: a queued run GitHub never places is auto-cancelled after 24 hours. That is
what happened between 2026-08-09 10:12 UTC and 2026-08-10 10:13 UTC, when the supervisor was
down — one `ycsb-cluster-nightly` run was cancelled and the next night's `stress-large-data`
waited 3h45 for a runner. Nothing alarms on this; check the host if a night is missing
entirely.

## Prerequisites

- Docker, and `gh` authenticated as a **repo admin on every served repo** (to mint
  registration tokens), plus `jq`.

## Setup

```sh
# 1. Build the runner image (once; node 24 + build toolchain + the Actions runner)
docker build -t harper-bench-runner benchmarks/ycsb/runner

# 2. Run the supervisor. It polls each repo and drains one queued harper-bench job at a
#    time. Keep it alive as a `systemd --user` service (see bench-runner-supervisor.service)
#    or in tmux/screen.
REPOS="HarperFast/harper-pro HarperFast/harper" RUNNER_CPUS=16 \
  ./benchmarks/ycsb/runner/bench-runner-supervisor.sh
```

`bench-runner-supervisor.service` is an example `systemd --user` unit — copy the supervisor
script somewhere stable (e.g. `~/dev/scripts/`), adjust the unit's paths/`REPOS`, then:

```sh
systemctl --user enable --now bench-runner-supervisor.service
```

Trigger a test run (the supervisor picks it up within a poll cycle, ~20s):

```sh
gh workflow run ycsb-cluster-nightly.yml --repo HarperFast/harper-pro -f scale=quick
```

### Knobs (env)

- `REPOS` — space-separated repos to serve, polled in priority order (default
  `HarperFast/harper-pro HarperFast/harper`).
- `LABEL` — runner label the workflows target (default `harper-bench`).
- `POLL` — seconds between queue scans (default `20`).
- `RUNNER_CPUS` / `RUNNER_MEMORY` / `RUNNER_MEMORY_RESERVATION` — per-container caps so the
  host keeps headroom (defaults 16 / 16g / 8g).
- `MAX_JOB_SECONDS` — backstop kill for a single drain if a queued job vanishes before the
  runner binds it (default 12000 = 200 min, above the longest workflow `timeout-minutes`).

## Sandboxing & safety notes

- **Container isolation** keeps the job off your host filesystem; `--rm` + `--ephemeral`
  means no state survives a job.
- **`RUNNER_CPUS`** caps the container so your desktop keeps cores. Containers don't
  _reserve_ CPU, so still schedule nightlies off-hours and avoid heavy desktop load during
  them, or the numbers absorb that contention.
- **No secrets in the image**: registration tokens are minted at runtime via your `gh` auth.
- **Triggers**: the workflows have no `pull_request` trigger by design. Don't add one.
- **Teardown**: stop the supervisor (`systemctl --user stop …` or Ctrl-C). Ephemeral
  runners de-register themselves on exit; remove a stale one with
  `gh api -X DELETE repos/<owner>/<repo>/actions/runners/<id>`.

## Tradeoffs

- **Ephemeral re-clones + rebuilds each run** (~minutes). Fine for a nightly.
- **~20 s pickup latency** (the poll interval) vs. an always-online runner — negligible for
  nightly perf jobs, and the price of one host safely serving multiple repos serially.
- Numbers are only comparable while the hardware and `RUNNER_CPUS` stay fixed — once stable,
  tighten the regression `alert-threshold`s in the workflows.
