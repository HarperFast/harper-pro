# Self-hosted bench runner (YCSB cluster nightly)

A fixed, sandboxed GitHub Actions runner for the
[`ycsb-cluster-nightly`](../../../.github/workflows/ycsb-cluster-nightly.yml) workflow.
A 3 × `threads.count=4` cluster is too large/variable for GitHub's shared runners, so
the cluster trends only mean something on consistent hardware. This runs the runner in a
**Docker container** (filesystem/process isolation from your host), **ephemeral** (one job
per container, then re-registered), **repo-scoped** to `HarperFast/harper-pro`, and the
workflow is **schedule + manual only — never `pull_request`** so PR code can't execute here.

## Prerequisites

- Docker, and `gh` authenticated as a repo **admin** (to mint registration tokens).
- A private repo (this is scoped to `harper-pro`); do **not** point a self-hosted runner at
  the public `harper` repo.

## Setup

```sh
# 1. Build the runner image (once; ~node 24 + build toolchain + the Actions runner)
docker build -t harper-bench-runner benchmarks/ycsb/runner

# 2. Start the launcher. It mints a fresh token each cycle and runs one job per
#    container. Keep it alive in tmux/screen, or as a `systemd --user` service.
RUNNER_CPUS=16 ./benchmarks/ycsb/runner/run-bench-runner.sh
```

The runner registers with label `harper-bench` and shows up under
**Settings → Actions → Runners**. Trigger a test run:

```sh
gh workflow run ycsb-cluster-nightly.yml --repo HarperFast/harper-pro -f scale=quick
```

## Sandboxing & safety notes

- **Container isolation** keeps the job off your host filesystem; `--rm` + `--ephemeral`
  means no state survives a job.
- **`RUNNER_CPUS`** (default 16 of your 20) caps the container so your desktop keeps cores.
  Containers don't _reserve_ CPU, so still schedule the nightly off-hours (the cron is
  ~03:00 America/Denver) — and ideally don't run heavy desktop apps during it, or the
  numbers absorb that contention.
- **No secrets in the image**: the registration token is minted at runtime by the host
  launcher via your `gh` auth.
- **Triggers**: the workflow has no `pull_request` trigger by design. Don't add one.
- **Teardown**: stop the launcher (Ctrl-C); remove the runner from the repo with
  `gh api -X DELETE repos/HarperFast/harper-pro/actions/runners/<id>` (or the Settings UI).

## Tradeoffs

- **Ephemeral re-clones + rebuilds harper-pro each run** (~minutes). Fine for a nightly; if
  you want faster runs, switch to a persistent container (drop `--ephemeral`/`--rm` and
  `config.sh` once) at the cost of state persisting between jobs.
- Numbers are only comparable while the hardware and `RUNNER_CPUS` stay fixed — once stable,
  tighten the regression `alert-threshold`s in the workflow.
