#!/usr/bin/env bash
# Runs as root on the server VM; the orchestrator on the client VM drives it over SSH.
# Settings come from /etc/memory-curve.env, written by server-setup.sh.
set -euo pipefail
# shellcheck source=/dev/null
source /etc/memory-curve.env

CONTAINER=harper
ROOT="$DATA_MOUNT/harper"
PRISTINE="$DATA_MOUNT/pristine"

container_pid() {
	docker inspect -f '{{.State.Pid}}' "$CONTAINER" 2>/dev/null || echo 0
}

container_cgroup() {
	local pid
	pid=$(container_pid)
	[ "$pid" -gt 0 ] || { echo "container $CONTAINER is not running" >&2; return 1; }
	echo "/sys/fs/cgroup$(sed -n 's/^0:://p' "/proc/$pid/cgroup")"
}

ops() {
	curl -sS --fail-with-body -m "${2:-60}" -u "admin:$ADMIN_PASSWORD" -H 'Content-Type: application/json' \
		-X POST http://127.0.0.1:9925/ -d "$1"
}

wait_ready() {
	local deadline=$((SECONDS + 600))
	until ops '{"operation":"describe_table","database":"data","table":"usertable"}' 10 >/dev/null 2>&1; do
		if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != true ]; then
			docker logs --tail 50 "$CONTAINER" >&2 || true
			echo "Harper container exited during startup" >&2
			return 1
		fi
		[ $SECONDS -lt $deadline ] || { echo "Harper not ready after 600 s" >&2; return 1; }
		sleep 1
	done
	until curl -sSf -o /dev/null -m 5 -u "admin:$ADMIN_PASSWORD" "http://127.0.0.1:9926/usertable/?id=ready-probe"; do
		[ $SECONDS -lt $deadline ] || { echo "REST route not ready after 600 s" >&2; return 1; }
		sleep 1
	done
}

cmd="${1:-}"
shift || true
case "$cmd" in
counters)
	cg=$(container_cgroup)
	devnum=$(lsblk -dno MAJ:MIN "$DATA_DEV" | tr -d ' ')
	echo "@@ time"
	date +%s.%N
	echo "@@ devnum"
	echo "$devnum"
	echo "@@ diskstats"
	awk -v d="$(basename "$(readlink -f "$DATA_DEV")")" '$3 == d' /proc/diskstats
	for f in io.stat memory.stat memory.events cpu.stat memory.pressure io.pressure cpu.pressure memory.current memory.max memory.high; do
		echo "@@ $f"
		cat "$cg/$f"
	done
	echo "@@ container"
	docker inspect -f '{{.State.StartedAt}} {{.RestartCount}} {{.State.OOMKilled}} {{.State.Pid}}' "$CONTAINER"
	;;
start)
	# start <memory.max bytes|unlimited> <memory.high bytes|max> <block cache bytes> <write buffer manager bytes>
	max="$1" high="$2" block_cache="$3" wbm="$4"
	memory_args=()
	if [ "$max" != unlimited ]; then memory_args=(--memory "$max" --memory-swap "$max"); fi
	docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
	# Mirrors host-manager's compose template for a Level-2 instance (src/templates/compose.yaml):
	# 4 CPUs, 8 threads, its RocksDB and heap settings and read-IOPS cap; plain HTTP on 9926.
	docker run -d --name "$CONTAINER" --network host --cpus 4 --pids-limit 4096 "${memory_args[@]}" \
		--device-read-iops "$(readlink -f "$DATA_DEV"):$READ_IOPS_LIMIT" \
		-v "$ROOT:/home/harperdb/harper" \
		-e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
		-e NODE_ENV=production -e NODE_HOSTNAME=bench-server -e HARPER_EXIT_ON_RESTART=true \
		-e OPERATIONSAPI_NETWORK_PORT=9925 -e OPERATIONSAPI_NETWORK_SECUREPORT=null \
		-e HTTP_PORT=9926 -e HTTP_SECUREPORT=null -e HTTP_KEEPALIVETIMEOUT=301000 \
		-e THREADS_MAXHEAPMEMORY=2000 -e UV_THREADPOOL_SIZE=8 -e REPLICATION_SECUREPORT=9933 \
		-e STORAGE_RECLAMATION_THRESHOLD=0.6 \
		-e STORAGE_ROCKS_BLOCKCACHESIZE="$block_cache" -e STORAGE_ROCKS_WRITEBUFFERMANAGERSIZE="$wbm" \
		-e STORAGE_ROCKS_WRITEBUFFERMANAGERCOSTTOCACHE=true -e STORAGE_ROCKS_WRITEBUFFERMANAGERALLOWSTALL=false \
		-e HARPER_SET_CONFIG='{"threads":{"count":8},"analytics":{"replicate":false},"operationsApi":{"sysInfo":{"disk":false}},"http":{"http2":false},"logging":{"stdStreams":true,"file":true}}' \
		"$IMAGE" >/dev/null
	# host-manager sets memory.high on the running container too (src/helpers/container.js applyMemoryHigh).
	if [ "$high" != max ]; then
		for _ in $(seq 1 50); do cg=$(container_cgroup 2>/dev/null) && break; sleep 0.2; done
		echo "$high" >"$cg/memory.high"
	fi
	wait_ready
	;;
stop)
	docker stop -t 300 "$CONTAINER" >/dev/null 2>&1 || true
	docker logs --tail 200 "$CONTAINER" >"$DATA_MOUNT/last-container.log" 2>&1 || true
	docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
	;;
logs)
	cat "$DATA_MOUNT/last-container.log" 2>/dev/null || true
	;;
drop-caches)
	sync
	echo 3 >/proc/sys/vm/drop_caches
	;;
init-root)
	rm -f "$DATA_MOUNT/pristine.ok"
	rm -rf "$ROOT" "$PRISTINE"
	mkdir -p "$ROOT/components"
	cp -r "$APP_DIR" "$ROOT/components/usertable"
	chown -R 1000:1000 "$ROOT"
	;;
snapshot)
	rm -f "$DATA_MOUNT/pristine.ok"
	rm -rf "$PRISTINE"
	cp -a --reflink=always "$ROOT" "$PRISTINE"
	touch "$DATA_MOUNT/pristine.ok"
	;;
has-snapshot)
	[ -f "$DATA_MOUNT/pristine.ok" ] && echo yes || echo no
	;;
restore)
	[ -f "$DATA_MOUNT/pristine.ok" ] || { echo "no pristine snapshot" >&2; exit 1; }
	rm -rf "$ROOT"
	cp -a --reflink=always "$PRISTINE" "$ROOT"
	;;
warm-page-cache)
	# Only for the unconstrained calibration: these reads are charged to this shell's cgroup, not the container's.
	find "$ROOT" -type f \( -name '*.sst' -o -name '*.blob' \) -print0 | xargs -0 -r -P 4 cat >/dev/null
	;;
metrics)
	ops '{"operation":"system_information","attributes":["metrics"]}'
	;;
sizes)
	sum_bytes() { find "$ROOT" -type f -name "$1" -printf '%s\n' | awk '{s+=$1} END {print s+0}'; }
	printf '{"totalBytes":%s,"sstBytes":%s,"blobBytes":%s}\n' \
		"$(du -sb "$ROOT" | cut -f1)" "$(sum_bytes '*.sst')" "$(sum_bytes '*.blob')"
	;;
fio)
	file="$DATA_MOUNT/fio.test"
	common=(--filename="$file" --size=32G --direct=1 --ioengine=libaio --rw=randread --bs=4k --time_based --group_reporting --output-format=json)
	fio --name=layout --filename="$file" --size=32G --rw=write --bs=1M --direct=1 --ioengine=libaio --iodepth=8 --output-format=json >/dev/null
	echo '{"qd1":'
	fio --name=qd1 "${common[@]}" --iodepth=1 --numjobs=1 --runtime=60
	echo ',"qd256":'
	fio --name=qd256 "${common[@]}" --iodepth=64 --numjobs=4 --runtime=60
	echo '}'
	rm -f "$file"
	;;
*)
	echo "usage: server-ctl.sh counters|start|stop|logs|drop-caches|warm-page-cache|init-root|snapshot|has-snapshot|restore|metrics|sizes|fio" >&2
	exit 2
	;;
esac
