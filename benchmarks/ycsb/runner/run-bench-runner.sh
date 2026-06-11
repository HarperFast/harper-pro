#!/usr/bin/env bash
# Host-side launcher for the ephemeral YCSB bench runner.
#
# Each iteration mints a fresh repo-scoped registration token (via your gh auth,
# so no PAT lives in the container) and starts one throwaway container that
# processes a single job and exits. The container is capped to RUNNER_CPUS cores
# so your desktop keeps headroom. Run under tmux/screen, or install as a
# `systemd --user` service for always-on availability.
#
#   ./run-bench-runner.sh
#
# Requires: docker, gh (authenticated, admin on the repo), and the image built:
#   docker build -t harper-bench-runner benchmarks/ycsb/runner
set -euo pipefail

REPO="${REPO:-HarperFast/harper-pro}"
IMAGE="${IMAGE:-harper-bench-runner}"
LABELS="${LABELS:-harper-bench}"
RUNNER_CPUS="${RUNNER_CPUS:-16}" # leave cores for the host desktop
# Container memory limits:
#   --memory             -> cgroup memory.max  (hard limit; OOM boundary)
#   --memory-reservation -> cgroup memory.low (soft reservation / reclaim floor)
# Default 16 GB / 8 GB: the large-catchup test runs BOTH Harper nodes plus the
# test runner inside this one container, so it needs roughly twice a single
# Fabric instance's budget to complete a 10 GB catch-up without timing out.
#
# To exercise tighter, Fabric-instance-scale memory pressure with a proactive
# throttle, set RUNNER_CGROUP_PARENT to a systemd slice whose MemoryHigh is
# configured out-of-band (docker can't set cgroup memory.high directly), e.g.
#   sudo: create harper-bench.slice with [Slice] MemoryHigh=<N>G
#   RUNNER_MEMORY=8g RUNNER_MEMORY_RESERVATION=4g \
#     RUNNER_CGROUP_PARENT=harper-bench.slice ./run-bench-runner.sh
# Empty (default) skips the slice — no memory.high, fully portable.
RUNNER_MEMORY="${RUNNER_MEMORY:-16g}"
RUNNER_MEMORY_RESERVATION="${RUNNER_MEMORY_RESERVATION:-8g}"
RUNNER_CGROUP_PARENT="${RUNNER_CGROUP_PARENT:-}"

command -v docker >/dev/null || { echo "docker not found"; exit 1; }
command -v gh >/dev/null || { echo "gh not found"; exit 1; }

echo "[bench-runner] repo=${REPO} image=${IMAGE} labels=${LABELS} cpus=${RUNNER_CPUS} memory=${RUNNER_MEMORY} reservation=${RUNNER_MEMORY_RESERVATION} cgroup-parent=${RUNNER_CGROUP_PARENT:-<none>}"
trap 'echo "[bench-runner] stopping"; exit 0' INT TERM

while true; do
	echo "[bench-runner] minting registration token..."
	TOKEN="$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" --jq .token)"
	echo "[bench-runner] starting ephemeral container (online, waiting for a job)..."
	docker run --rm \
		--cpus "${RUNNER_CPUS}" \
		--memory "${RUNNER_MEMORY}" \
		--memory-reservation "${RUNNER_MEMORY_RESERVATION}" \
		${RUNNER_CGROUP_PARENT:+--cgroup-parent "${RUNNER_CGROUP_PARENT}"} \
		-e RUNNER_REPO_URL="https://github.com/${REPO}" \
		-e RUNNER_TOKEN="${TOKEN}" \
		-e RUNNER_LABELS="${LABELS}" \
		"${IMAGE}" || echo "[bench-runner] container exited non-zero (continuing)"
	echo "[bench-runner] job finished; re-registering in 5s..."
	sleep 5
done
