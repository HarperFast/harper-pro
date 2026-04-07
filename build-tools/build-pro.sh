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

function cleanup {
  if use_git; then
    echo -e "\n📦 Restoring core files"
    pushd core
    git restore .
    popd
    echo -e "\n📦 Restoring package-lock.json"
    git restore package-lock.json
    echo -e "\n📦 Removing npm-shrinkwrap.json"
    rm npm-shrinkwrap.json
  fi
}

trap cleanup EXIT

if [[ "$IGNORE_PACKAGE_JSON_DIFF" != "true" ]]; then
  if use_git && ! git diff --quiet package.json; then
    echo 'package.json has local changes; please restore or commit before running build'
    exit 1
  fi
fi

echo -e "\n📦 Installing production deps"
npm ci

echo -e "\n📦 Applying Harper Pro branding"
perl -pi -e 's/Harper/Harper Pro/g' ./core/bin/*.js ./core/utility/install/installer.js

echo -e "\n📦 Building project"
npm run build || true

echo -e "\n📦 Creating shrinkwrap"
npm shrinkwrap

./build-tools/build-studio.sh

echo -e "\n📦 Building package"
npm pack

version=$(npm pkg get version | tr -d \")
packageFile="harperfast-harper-pro-${version}.tgz"
echo -e "\n📦 Built Harper Pro ${version} in ${packageFile}"
echo "📦 Run 'npm publish ${packageFile}' to release"
