#!/usr/bin/env bash
# Just-in-time supervisor for the harper-bench self-hosted runner host.
#
# WHY THIS EXISTS (not an org-level runner): org-scoped self-hosted runners are
# not routed jobs for the HarperFast repos — the org's runner groups are
# inherited from the GitHub Enterprise level and self-hosted org runners never
# bind these repos' jobs (verified empirically: an org runner in an all-repos
# group sat idle while a matching job queued indefinitely; a repo-scoped runner
# bound the same job in ~15s). REPO-scoped runners work, but a repo runner only
# serves one repo. To share this one host across multiple repos while keeping a
# single perf executor (so benchmark numbers stay comparable night to night),
# this supervisor polls each repo for a queued job that targets the bench label
# and, when it finds one, registers a throwaway repo-scoped --ephemeral runner
# that drains exactly that job and exits. Draining is blocking, so at most one
# job ever runs at a time across all repos — strictly serial, no lock required.
#
# Run under systemd --user (see bench-runner-supervisor.service). Requires:
# docker, gh (authenticated; repo-admin on each REPO), and the image built:
#   docker build -t harper-bench-runner benchmarks/ycsb/runner
set -euo pipefail

# Space-separated list of repos to serve, polled in order (earlier = higher
# priority when jobs are queued in more than one at the same time).
REPOS_STR="${REPOS:-HarperFast/harper-pro HarperFast/harper}"
read -r -a REPOS <<<"${REPOS_STR}"
LABEL="${LABEL:-harper-bench}"
IMAGE="${IMAGE:-harper-bench-runner}"
POLL="${POLL:-20}"               # seconds between queue scans
# Backstop: if a runner is started but its job vanished (cancelled in the gap)
# it would otherwise wait for work forever and wedge the supervisor. Cap a single
# drain above the longest workflow timeout-minutes (stress-large-data = 180m).
MAX_JOB_SECONDS="${MAX_JOB_SECONDS:-12000}" # 200 min

RUNNER_CPUS="${RUNNER_CPUS:-16}"            # leave cores for the host desktop
RUNNER_MEMORY="${RUNNER_MEMORY:-16g}"
RUNNER_MEMORY_RESERVATION="${RUNNER_MEMORY_RESERVATION:-8g}"
RUNNER_CGROUP_PARENT="${RUNNER_CGROUP_PARENT:-}"

command -v docker >/dev/null || { echo "docker not found"; exit 1; }
command -v gh >/dev/null || { echo "gh not found"; exit 1; }
command -v jq >/dev/null || { echo "jq not found"; exit 1; }

log() { echo "[bench-supervisor] $*"; }

# True if $repo has a queued job whose labels include $LABEL.
has_queued_bench_job() {
	local repo="$1" ids id
	ids="$(gh api "repos/${repo}/actions/runs?status=queued&per_page=30" --jq '.workflow_runs[].id' 2>/dev/null)" || return 1
	for id in ${ids}; do
		if gh api "repos/${repo}/actions/runs/${id}/jobs" \
			--jq ".jobs[] | select(.status==\"queued\") | .labels[]" 2>/dev/null \
			| grep -qx "${LABEL}"; then
			return 0
		fi
	done
	return 1
}

# Register a throwaway repo-scoped ephemeral runner that drains exactly one job.
drain_one() {
	local repo="$1" token
	token="$(gh api -X POST "repos/${repo}/actions/runners/registration-token" --jq .token 2>/dev/null)" \
		|| { log "token mint failed for ${repo} (skipping)"; return; }
	log "draining one ${LABEL} job for ${repo}..."
	timeout "${MAX_JOB_SECONDS}" docker run --rm \
		--cpus "${RUNNER_CPUS}" \
		--memory "${RUNNER_MEMORY}" \
		--memory-reservation "${RUNNER_MEMORY_RESERVATION}" \
		${RUNNER_CGROUP_PARENT:+--cgroup-parent "${RUNNER_CGROUP_PARENT}"} \
		-e RUNNER_REPO_URL="https://github.com/${repo}" \
		-e RUNNER_TOKEN="${token}" \
		-e RUNNER_LABELS="${LABEL}" \
		"${IMAGE}" \
		|| log "container for ${repo} exited non-zero / timed out (continuing)"
	log "drain for ${repo} complete"
}

log "repos=[${REPOS[*]}] label=${LABEL} image=${IMAGE} poll=${POLL}s cpus=${RUNNER_CPUS} memory=${RUNNER_MEMORY}"
trap 'log "stopping"; exit 0' INT TERM

while true; do
	for repo in "${REPOS[@]}"; do
		if has_queued_bench_job "${repo}"; then
			drain_one "${repo}"
		fi
	done
	sleep "${POLL}"
done
