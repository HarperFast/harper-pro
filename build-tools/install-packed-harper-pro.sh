#!/usr/bin/env bash
# Install a packed harper-pro tarball into the global npm prefix with exactly the dependency tree its
# npm-shrinkwrap.json records, as an install of the published package from the registry would.
#
# `npm install --global <tgz>` ignores the shrinkwrap inside a local tarball and re-resolves every
# range, so this extracts the package where a global install puts it and runs `npm ci` there. The
# shrinkwrap has its devDependencies pruned (prune-shrinkwrap-dev.mjs) while the packed package.json
# still lists them, which `npm ci` rejects, so they are dropped for the install and the published
# manifest is restored afterwards.
#
# Usage: install-packed-harper-pro.sh <harperfast-harper-pro-*.tgz>
set -euo pipefail

tgz=$(realpath "$1")
pkg="${NPM_CONFIG_PREFIX:?}/lib/node_modules/@harperfast/harper-pro"

mkdir -p "$pkg"
tar -xzf "$tgz" -C "$pkg" --strip-components=1
(cd "$pkg" && npm pkg delete devDependencies && npm ci --omit=dev --no-audit --no-fund)
tar -xzf "$tgz" -C "$pkg" --strip-components=1 package/package.json
npm rebuild --global --ignore-scripts --bin-links=true @harperfast/harper-pro
node "$(dirname "$0")/check-installed-shrinkwrap.mjs" "$pkg"
