#!/usr/bin/env bash

set -e

if [[ -z "$1" ]]; then
  echo "Usage: $0 <branch-name>"
  exit 1
fi

BRANCH_NAME=$1

echo -e "\n📦 Setting core submodule branch to $BRANCH_NAME"
git submodule set-branch --branch "$BRANCH_NAME" core

echo -e "\n✅ Submodule branch set successfully! You may want to run 'npm run core:sync' next."
