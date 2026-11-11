#!/usr/bin/env bash
# Run as root: server-setup.sh <source.tgz> <password-file>
set -euo pipefail
src_tgz="$1"
password_file="$2"
DATA_DEV=/dev/disk/by-id/google-data
DATA_MOUNT=/mnt/data
IMAGE=harper-pro-bench:local
export DEBIAN_FRONTEND=noninteractive

# Keep background jobs off the disks while cells run.
systemctl stop unattended-upgrades apt-daily.timer apt-daily-upgrade.timer fstrim.timer 2>/dev/null || true
systemctl disable unattended-upgrades apt-daily.timer apt-daily-upgrade.timer fstrim.timer 2>/dev/null || true
snap refresh --hold 2>/dev/null || true

dev=$(readlink -f "$DATA_DEV")
if [ "$(readlink -f /dev/disk/by-id/google-persistent-disk-0)" = "$dev" ]; then
	echo "refusing: $DATA_DEV resolves to the boot disk" >&2
	exit 1
fi
if ! findmnt -n "$DATA_MOUNT" >/dev/null; then
	if [ -n "$(lsblk -no MOUNTPOINT "$dev" | tr -d '[:space:]')" ]; then
		echo "refusing: $dev or one of its partitions is mounted" >&2
		exit 1
	fi
	size=$(lsblk -bdno SIZE "$dev")
	if [ "$size" -lt $((300 * 1024 ** 3)) ]; then
		echo "refusing: $dev is only $size bytes; expected the 400 GB data disk" >&2
		exit 1
	fi
	if blkid "$dev" >/dev/null 2>&1 || [ -n "$(lsblk -no NAME "$dev" | tail -n +2)" ]; then
		echo "refusing: $dev already has a filesystem or partitions" >&2
		exit 1
	fi
	apt-get update -q
	apt-get install -y -q xfsprogs
	# reflink lets server-ctl.sh restore the post-load dataset for every cell without copying it.
	mkfs.xfs -q -m reflink=1 -L mcdata "$dev"
	mkdir -p "$DATA_MOUNT"
	mount -o noatime "$dev" "$DATA_MOUNT"
fi

if ! command -v docker >/dev/null || ! docker buildx version >/dev/null 2>&1; then
	apt-get update -q
	apt-get install -y -q ca-certificates curl
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
		>/etc/apt/sources.list.d/docker.list
	apt-get update -q
	apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin
fi
apt-get install -y -q fio jq
systemctl enable --now docker

rm -rf /opt/memory-curve/src
mkdir -p /opt/memory-curve/src
tar -xzf "$src_tgz" -C /opt/memory-curve/src
install -m 0755 /opt/memory-curve/src/benchmarks/memory-curve/server-ctl.sh /opt/memory-curve/server-ctl.sh

umask 077
cat >/etc/memory-curve.env <<EOF
DATA_DEV=$DATA_DEV
DATA_MOUNT=$DATA_MOUNT
IMAGE=$IMAGE
APP_DIR=/opt/memory-curve/src/core/benchmarks/ycsb/app
READ_IOPS_LIMIT=20000
ADMIN_PASSWORD=$(cat "$password_file")
EOF
rm -f "$password_file"

docker build -q -t "$IMAGE" /opt/memory-curve/src >/opt/memory-curve/image-id
docker run --rm --entrypoint harper "$IMAGE" version
