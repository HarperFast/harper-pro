#!/usr/bin/env bash
# Host-side launcher for the ephemeral YCSB bench runner.
#
# Each iteration mints a fresh registration token (via your gh auth, so no PAT
# lives in the container) and starts one throwaway container that processes a
# single job and exits. The container is capped to RUNNER_CPUS cores so your
# desktop keeps headroom. Run under tmux/screen, or install as a
# `systemd --user` service for always-on availability.
#
# SCOPE=org (default) registers an ORG-level runner shared across HarperFast
# repos (e.g. harper + harper-pro), so a single host loop — and thus a single
# job at a time — serves every repo's bench workflow. Requires the gh token to
# carry the admin:org scope (`gh auth refresh -h github.com -s admin:org` once).
# SCOPE=repo falls back to the old single-repo (REPO) registration.
#
#   ./run-bench-runner.sh
#   SCOPE=repo ./run-bench-runner.sh   # legacy single-repo behavior
#
# Requires: docker, gh (authenticated; admin:org for SCOPE=org, repo-admin for
# SCOPE=repo), and the image built:
#   docker build -t harper-bench-runner benchmarks/ycsb/runner
set -euo pipefail

SCOPE="${SCOPE:-org}"                  # org = shared across HarperFast repos; repo = single-repo
ORG="${ORG:-HarperFast}"
REPO="${REPO:-HarperFast/harper-pro}"  # only used when SCOPE=repo
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

if [ "${SCOPE}" = org ]; then
	TARGET="org=${ORG}"
else
	TARGET="repo=${REPO}"
fi
echo "[bench-runner] scope=${SCOPE} ${TARGET} image=${IMAGE} labels=${LABELS} cpus=${RUNNER_CPUS} memory=${RUNNER_MEMORY} reservation=${RUNNER_MEMORY_RESERVATION} cgroup-parent=${RUNNER_CGROUP_PARENT:-<none>}"
trap 'echo "[bench-runner] stopping"; exit 0' INT TERM

while true; do
	echo "[bench-runner] minting ${SCOPE}-scoped registration token..."
	if [ "${SCOPE}" = org ]; then
		TOKEN="$(gh api -X POST "orgs/${ORG}/actions/runners/registration-token" --jq .token)"
		RUNNER_URL="https://github.com/${ORG}"
	else
		TOKEN="$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" --jq .token)"
		RUNNER_URL="https://github.com/${REPO}"
	fi
	echo "[bench-runner] starting ephemeral container (online, waiting for a job)..."
	docker run --rm \
		--cpus "${RUNNER_CPUS}" \
		--memory "${RUNNER_MEMORY}" \
		--memory-reservation "${RUNNER_MEMORY_RESERVATION}" \
		${RUNNER_CGROUP_PARENT:+--cgroup-parent "${RUNNER_CGROUP_PARENT}"} \
		-e RUNNER_REPO_URL="${RUNNER_URL}" \
		-e RUNNER_TOKEN="${TOKEN}" \
		-e RUNNER_LABELS="${LABELS}" \
		"${IMAGE}" || echo "[bench-runner] container exited non-zero (continuing)"
	echo "[bench-runner] job finished; re-registering in 5s..."
	sleep 5
done
