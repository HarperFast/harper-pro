#!/usr/bin/env bash
# Starts, stops and reports the detached orchestrator on the client VM. Liveness is the recorded
# PID, never a pgrep pattern, which would match the SSH shell that carries it.
set -euo pipefail
cd /opt/memory-curve

alive() {
	local pid
	pid=$(cat orchestrator.pid 2>/dev/null) || return 1
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && grep -q orchestrate.mts "/proc/$pid/cmdline"
}

case "${1:-}" in
start)
	if alive; then exit 0; fi
	setsid nohup bash -c 'ulimit -n 65536; exec /opt/node/bin/node src/benchmarks/memory-curve/orchestrate.mts --plan plan.json --out results' \
		>>orchestrate.out 2>&1 </dev/null &
	echo $! >orchestrator.pid
	;;
stop)
	if alive; then kill "$(cat orchestrator.pid)"; fi
	;;
status)
	for marker in DONE FAILED; do
		if [ -f "results/$marker" ]; then echo "marker=$marker"; fi
	done
	if alive; then echo alive=yes; fi
	cat results/status.json 2>/dev/null || echo '{}'
	;;
*)
	echo "usage: client-ctl.sh start|stop|status" >&2
	exit 2
	;;
esac
