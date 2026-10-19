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
# job ever runs at a time across all repos; a machine-wide flock also keeps a
# drain from overlapping a local benchmark.
#
# Run under systemd --user (see bench-runner-supervisor.service). Requires:
# docker, gh (authenticated; repo-admin on each REPO), jq, flock, passwordless
# `sudo cpupower` (it owns the turbo state, see README), and the image built:
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

ETAG_DIR="${ETAG_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/bench-supervisor-etags}"
mkdir -p "${ETAG_DIR}"

# GET a REST path, printing its body. Conditional on the last ETag: a 304 does not count
# against the core rate limit, and this loop re-asks the same questions every POLL seconds.
gh_get_cached() {
	local path="$1" key raw status etag
	key="${ETAG_DIR}/$(printf %s "${path}" | md5sum | cut -c1-32)"
	etag="$(cat "${key}.etag" 2>/dev/null || true)"
	# gh exits non-zero on 304, so read the status line instead of the exit code.
	raw="$(gh api -i ${etag:+-H "If-None-Match: ${etag}"} "${path}" 2>/dev/null | tr -d '\r' || true)"
	status="$(printf '%s\n' "${raw}" | head -1 | awk '{print $2}')"
	case "${status}" in
		304) cat "${key}.body" ;;
		200)
			printf '%s\n' "${raw}" | awk 'body{print;next} /^$/{body=1}' > "${key}.body"
			printf '%s\n' "${raw}" | awk -F': ' 'tolower($1)=="etag"{print $2; exit}' > "${key}.etag"
			cat "${key}.body" ;;
		*) return 1 ;;
	esac
}

# True if $repo has a queued job whose labels include $LABEL.
has_queued_bench_job() {
	local repo="$1" ids id
	ids="$(gh_get_cached "repos/${repo}/actions/runs?status=queued&per_page=30" | jq -r '.workflow_runs[].id')" || return 1
	for id in ${ids}; do
		if gh_get_cached "repos/${repo}/actions/runs/${id}/jobs" \
			| jq -r ".jobs[] | select(.status==\"queued\") | .labels[]" 2>/dev/null \
			| grep -qx "${LABEL}"; then
			return 0
		fi
	done
	return 1
}

# Machine-wide benchmark lock shared with ~/dev/scripts/bench-run, so a CI drain never
# overlaps a local benchmark. Taken before minting the token (tokens expire after 1h).
BENCH_LOCK_DIR="${BENCH_LOCK_DIR:-$HOME/dev/tmp/bench-lock}"
mkdir -p "${BENCH_LOCK_DIR}"

# Benchmarks run with turbo off (cores at base clock) so trend points are comparable; the host
# runs with turbo on whenever no benchmark holds the lock. The nightly workflow refuses to
# publish a run that did not see this state, so a failure here only costs that night's point.
NO_TURBO="${SYSFS_ROOT:-/sys}/devices/system/cpu/intel_pstate/no_turbo"
turbo_off_by_us=0

set_turbo_boost() { sudo -n cpupower set --turbo-boost "$1" >/dev/null 2>&1; }
turbo_is_off() { [ "$(cat "${NO_TURBO}" 2>/dev/null)" = 1 ]; }

turbo_off() {
	turbo_off_by_us=1
	if ! { set_turbo_boost 0 && turbo_is_off; }; then
		log "WARNING: could not turn turbo off; this job runs unpinned and stays off the trend"
	fi
}

turbo_on() {
	set_turbo_boost 1 || log "WARNING: could not turn turbo back on"
	turbo_off_by_us=0
}

# Turbo left off by a killed supervisor or bench-run: restore it, under the lock so a
# benchmark cannot start between the check and the write.
restore_stale_turbo() {
	local lock_fd
	turbo_is_off || return 0
	exec {lock_fd}>"${BENCH_LOCK_DIR}/lock"
	if flock -n "${lock_fd}"; then
		log "turbo is off with no benchmark holding the lock; turning it back on"
		turbo_on
	fi
	exec {lock_fd}>&-
}

# Register a throwaway repo-scoped ephemeral runner that drains exactly one job.
drain_one() {
	local repo="$1" lock_fd
	exec {lock_fd}>"${BENCH_LOCK_DIR}/lock"
	if ! flock -n "${lock_fd}"; then
		log "waiting for benchmark lock: $(tr '\n' ' ' < "${BENCH_LOCK_DIR}/holder" 2>/dev/null)"
		flock "${lock_fd}"
	fi
	printf 'name: ci-drain %s\npid: %s\nstarted: %s\n' "${repo}" "$$" "$(date -Is)" > "${BENCH_LOCK_DIR}/holder"
	turbo_off
	drain_locked "${repo}" {lock_fd}>&-
	turbo_on
	rm -f "${BENCH_LOCK_DIR}/holder"
	exec {lock_fd}>&-
}

drain_locked() {
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
trap '[ "${turbo_off_by_us}" = 1 ] && turbo_on' EXIT
trap 'log "stopping"; exit 0' INT TERM

while true; do
	restore_stale_turbo
	for repo in "${REPOS[@]}"; do
		if has_queued_bench_job "${repo}"; then
			drain_one "${repo}"
		fi
	done
	sleep "${POLL}"
done
