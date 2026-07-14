#!/usr/bin/env bash
# Deterministic content signature over the pointer-compression base image's build
# inputs. publish-node-pc-image records a `sig-<hash>` tag from it; the daily
# check-node-pc-image-drift job recomputes it from the repo pins and probes for
# that tag. Both call THIS script so their hashes agree byte-for-byte — do not
# reimplement the formula in either workflow.
#
# Usage: pc-image-signature.sh <node-exact> <uws-source-commit> <pprof-version>
#   node-exact          e.g. 24.18.0 (no leading v)
#   uws-source-commit   the source_commit of the pinned uWebSockets.js archive
#   pprof-version       @datadog/pprof version from package-lock.json
set -euo pipefail

if [ "$#" -ne 3 ]; then
	echo "usage: $0 <node-exact> <uws-source-commit> <pprof-version>" >&2
	exit 2
fi

printf 'node=%s;uws=%s;pprof=%s' "$1" "$2" "$3" | sha256sum | cut -c1-16
