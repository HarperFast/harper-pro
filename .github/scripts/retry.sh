#!/usr/bin/env bash
# Retries a command up to 4 attempts with linear 30/60/90s backoff, used across the
# nightly stress/integration workflows to ride out transient npm-registry blips.
#
# Usage: retry.sh <label-for-log-lines> -- <command> [args...]
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "::error::retry.sh: usage: retry.sh <label> [--] <command> [args...]"
  exit 1
fi
label=$1
shift
if [ "${1:-}" = '--' ]; then
  shift
fi
if [ "$#" -eq 0 ]; then
  echo "::error::retry.sh: no command given for '${label}'"
  exit 1
fi

n=0
until "$@"; do
  n=$((n + 1))
  if [ "$n" -ge 4 ]; then
    echo "::error::${label} failed after $n attempts"
    exit 1
  fi
  delay=$((n * 30))
  echo "${label} failed (attempt $n/4); retrying in ${delay}s..."
  sleep "$delay"
done
