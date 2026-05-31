#!/usr/bin/env bash
# Configures the runner with a runtime-supplied registration token and runs a
# single job (--ephemeral), then exits so the host loop can re-register a fresh
# one. No token is persisted in the image.
set -euo pipefail

: "${RUNNER_REPO_URL:?RUNNER_REPO_URL is required}"
: "${RUNNER_TOKEN:?RUNNER_TOKEN is required}"

./config.sh \
	--url "${RUNNER_REPO_URL}" \
	--token "${RUNNER_TOKEN}" \
	--name "${RUNNER_NAME:-harper-bench-$(hostname)}" \
	--labels "${RUNNER_LABELS:-harper-bench}" \
	--work _work \
	--unattended \
	--ephemeral \
	--replace

exec ./run.sh
