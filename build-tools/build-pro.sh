#!/usr/bin/env bash

set -e

function use_git {
  # in some environments (e.g. Docker) we don't have the .git dir
  if [[ -n "$NO_USE_GIT" ]]; then
    return 1
  fi
  if command -v git >/dev/null 2>&1; then
    return 0
  fi
}

stage=""

function cleanup {
  if [[ -n "$stage" ]]; then
    rm -rf "$stage"
  fi
  if use_git; then
    echo -e "\n📦 Restoring core files"
    pushd core
    git restore .
    popd
  fi
}

trap cleanup EXIT

if [[ "$IGNORE_PACKAGE_JSON_DIFF" != "true" ]]; then
  if use_git && ! git diff --quiet package.json; then
    echo 'package.json has local changes; please restore or commit before running build'
    exit 1
  fi
fi

version=$(npm pkg get version | tr -d \")
packageFile="harperfast-harper-pro-${version}.tgz"
# A failed rebuild must not leave an earlier release archive available to publish.
rm -f harperfast-harper-pro-*.tgz

echo -e "\n📦 Installing locked deps"
# No install script may run before the bundle is copied: it could rewrite bundled JavaScript.
npm ci --ignore-scripts

echo -e "\n📦 Applying Harper Pro branding"
perl -pi -e 's/Harper/Harper Pro/g' ./core/bin/*.js ./core/utility/install/installer.js

echo -e "\n📦 Building project"
npm run build || true

./build-tools/build-studio.sh

echo -e "\n📦 Preparing portable dependency bundle"
mkdir -p node_modules/.cache
stage=$(mktemp -d "$PWD/node_modules/.cache/harper-pro-package.XXXXXX")
node core/build-tools/bundleDependencies.ts prepare "$PWD" "$stage/bundle"

echo -e "\n📦 Building package"
npm pack "$stage/bundle/package" --ignore-scripts --pack-destination "$stage"
mkdir "$stage/packed"
tar -xzf "$stage/$packageFile" --strip-components=1 -C "$stage/packed"
node core/build-tools/bundleDependencies.ts check "$stage/packed" "$PWD/package-lock.json"
node -e '
	const { existsSync, readFileSync } = require("node:fs");
	const { join } = require("node:path");
	const root = process.argv[1];
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const assets = [
		...Object.values(manifest.bin),
		manifest.main,
		manifest.exports["."],
		"index.d.ts",
		"static/defaultConfig.yaml",
		"studio/web/index.html",
	];
	const missing = assets.filter((asset) => !existsSync(join(root, asset)));
	if (missing.length) throw new Error(`Release archive is missing ${missing.join(", ")}`);
' "$stage/packed"
mv "$stage/$packageFile" "$packageFile"

# re2's binary comes only from its install script; the checkout's WAF and tests need it.
npm rebuild re2

echo -e "\n📦 Built Harper Pro ${version} in ${packageFile}"
echo "📦 Run 'npm publish ${packageFile}' to release"
