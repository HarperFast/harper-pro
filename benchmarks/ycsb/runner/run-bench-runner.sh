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
# Memory limit for the container. Harper auto-tunes its RocksDB block cache to
# 25% of process.constrainedMemory(), which reads the cgroup limit set here.
# Without a limit Harper uses 25% of totalmem() (~7.5 GB on a 30 GB machine),
# which combined with compaction pressure triggers OOM during 10 GB stress tests.
# 16 GB → 4 GB block cache; leaves ~14 GB headroom for the host desktop.
RUNNER_MEMORY="${RUNNER_MEMORY:-16g}"

command -v docker >/dev/null || { echo "docker not found"; exit 1; }
command -v gh >/dev/null || { echo "gh not found"; exit 1; }

echo "[bench-runner] repo=${REPO} image=${IMAGE} labels=${LABELS} cpus=${RUNNER_CPUS} memory=${RUNNER_MEMORY}"
trap 'echo "[bench-runner] stopping"; exit 0' INT TERM

while true; do
	echo "[bench-runner] minting registration token..."
	TOKEN="$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" --jq .token)"
	echo "[bench-runner] starting ephemeral container (online, waiting for a job)..."
	docker run --rm \
		--cpus "${RUNNER_CPUS}" \
		--memory "${RUNNER_MEMORY}" \
		-e RUNNER_REPO_URL="https://github.com/${REPO}" \
		-e RUNNER_TOKEN="${TOKEN}" \
		-e RUNNER_LABELS="${LABELS}" \
		"${IMAGE}" || echo "[bench-runner] container exited non-zero (continuing)"
	echo "[bench-runner] job finished; re-registering in 5s..."
	sleep 5
done
