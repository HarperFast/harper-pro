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
