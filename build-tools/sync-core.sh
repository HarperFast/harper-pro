#!/usr/bin/env bash

set -e

SKIP_INSTALL=false
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --skip-install) SKIP_INSTALL=true ;;
  esac
  shift
done

function use_git {
  # in some environments (e.g. Docker) we don't have the .git dir
  if [[ -n "$NO_USE_GIT" ]]; then
    return 1
  fi
  if command -v git >/dev/null 2>&1; then
    return 0
  fi
}

if [[ "$IGNORE_PACKAGE_JSON_DIFF" != "true" ]]; then
  if use_git && ! git diff --quiet package.json; then
    echo 'package.json has local changes; please restore or commit before running build'
    exit 1
  fi
fi

if use_git; then
  echo -e "\n📦 Updating core submodule"
  git submodule update --remote --recursive
fi

echo -e "\n📦 Copying lock file from core"
cp core/package-lock.json ./

echo -e "\n📦 Copying dependencies & devDependencies from core"
deps=$(cd core && npm pkg get dependencies)
npm pkg set "dependencies=${deps}" --json
devDeps=$(cd core && npm pkg get devDependencies)
npm pkg set "devDependencies=${devDeps}" --json
overrides=$(cd core && npm pkg get overrides)
npm pkg set "overrides=${overrides}" --json
optionalDependencies=$(cd core && npm pkg get optionalDependencies)
npm pkg set "optionalDependencies=${optionalDependencies}" --json

if [[ "$SKIP_INSTALL" != "true" ]]; then
  echo -e "\n📦 Installing core deps"
  npm install
else
  echo -e "\n📦 Skipping core deps installation"
fi

echo -e "\n🎉 Synchronized!"
