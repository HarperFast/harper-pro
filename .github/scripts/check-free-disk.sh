#!/usr/bin/env bash
# Fails unless <path> has at least <multiplier> x <data-gib> GiB free. The large-data stress
# tests run in a container on the shared harper-bench host, so a full host disk otherwise
# surfaces minutes later as a replication-wedge assertion instead of naming the cause.
#
# Usage: check-free-disk.sh <path> <data-gib> <multiplier>
set -uo pipefail

if [ "$#" -ne 3 ]; then
  echo "::error::check-free-disk.sh: usage: check-free-disk.sh <path> <data-gib> <multiplier>"
  exit 1
fi
path=$1
data_gib=$2
multiplier=$3

# Same number syntax for both the dataset (the tests parse it with Number()) and the multiplier.
number='^([0-9]+\.?[0-9]*|\.[0-9]+)$'
if ! [[ "$data_gib" =~ $number && "$multiplier" =~ $number ]] \
  || ! required=$(awk -v gib="$data_gib" -v times="$multiplier" 'BEGIN {
    bytes = gib * times * 1073741824
    if (bytes <= 0 || bytes > 2^53) exit 1
    ceiling = int(bytes)
    if (ceiling < bytes) ceiling++
    printf "%.0f", ceiling
  }'); then
  echo "::error::check-free-disk.sh: data size '${data_gib}' GiB x '${multiplier}' is not a positive, representable size"
  exit 1
fi

if ! df_out=$(df -B1 --output=avail "$path" 2>&1) \
  || ! available=$(printf '%s\n' "$df_out" | tail -n 1 | tr -d ' ') \
  || ! [[ "$available" =~ ^[0-9]+$ ]]; then
  echo "::error::check-free-disk.sh: cannot measure free space on ${path}: ${df_out}"
  exit 1
fi

gib() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1073741824 }'; }
report="${path}: $(gib "$available") GiB free, $(gib "$required") GiB required (${multiplier} x ${data_gib} GiB dataset)"

if [ "$available" -lt "$required" ]; then
  echo "::error::Not enough free disk on the harper-bench Docker host. ${report}. Reclaim space on that host (stopped containers, unused images, build cache: docker system df) before re-running."
  { echo "- ❌ ${report}" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"; } 2>/dev/null || true
  exit 1
fi
echo "$report"
{ echo "- ${report}" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"; } 2>/dev/null || true
