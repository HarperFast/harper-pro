#!/usr/bin/env bash
# Provisions the client VM: installs Node (checksum-verified) and unpacks the benchmark source.
# Run as root: client-setup.sh <source.tgz> <node version, e.g. v26.2.0> <owner user>
set -euo pipefail
src_tgz="$1"
node_version="$2"
owner="$3"
export DEBIAN_FRONTEND=noninteractive

systemctl stop unattended-upgrades apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true

if [ "$(/opt/node/bin/node --version 2>/dev/null)" != "$node_version" ]; then
	work=$(mktemp -d)
	archive="node-$node_version-linux-x64.tar.xz"
	curl -fsSL -o "$work/$archive" "https://nodejs.org/dist/$node_version/$archive"
	curl -fsSL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/$node_version/SHASUMS256.txt"
	(cd "$work" && grep " $archive\$" SHASUMS256.txt | sha256sum -c -)
	rm -rf /opt/node
	mkdir -p /opt/node
	tar -xJf "$work/$archive" -C /opt/node --strip-components=1
	rm -rf "$work"
fi

rm -rf /opt/memory-curve/src
mkdir -p /opt/memory-curve/src /opt/memory-curve/results
tar -xzf "$src_tgz" -C /opt/memory-curve/src
chown -R "$owner:$owner" /opt/memory-curve
