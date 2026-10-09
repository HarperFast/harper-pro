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
  # the ref `git submodule update --remote` would track: submodule.core.branch from .git/config over
  # .gitmodules (`.` meaning the superproject's own branch), else the remote's default branch
  CORE_BRANCH=$(git config --get submodule.core.branch || git config -f .gitmodules --get submodule.core.branch || echo HEAD)
  [[ "$CORE_BRANCH" == "." ]] && CORE_BRANCH=$(git rev-parse --abbrev-ref HEAD)
  CORE_REMOTE=$(git -C core config --get "branch.$(git -C core symbolic-ref --short -q HEAD || echo -).remote" || echo origin)
  CORE_BEFORE=$(git rev-parse HEAD:core)
  git -C core fetch --quiet "$CORE_REMOTE" "$CORE_BRANCH"
  CORE_AFTER=$(git -C core rev-parse FETCH_HEAD)
  "$(dirname "$0")/core-sync-guard.sh" core "$CORE_BEFORE" "$CORE_AFTER"
  git -C core checkout --quiet --detach "$CORE_AFTER"
  git -C core submodule update --init --recursive
fi

echo -e "\n📦 Copying lock file from core"
cp core/package-lock.json ./

echo -e "\n📦 Copying dependencies & devDependencies from core"
# harper-pro carries some dependencies/overrides that core doesn't know about
# (e.g. @datadog/pprof for analytics/profile.ts, re2 for security/safeRegex.ts —
# neither file exists in core). sync_pkg_field wholesale-copies each field from
# core but re-adds any entry that only exists on harper-pro's side, so a sync can
# never silently drop or downgrade a harper-pro-only dependency.
function sync_pkg_field {
  local field="$1"
  local pro_before core_value merged
  pro_before=$(npm pkg get "$field")
  core_value=$(cd core && npm pkg get "$field")
  merged=$(node -e '
    const [field, proBeforeJson, coreValueJson] = process.argv.slice(1);
    const proBefore = JSON.parse(proBeforeJson);
    const coreValue = JSON.parse(coreValueJson);
    const merged = { ...coreValue };
    for (const [key, value] of Object.entries(proBefore)) {
      if (!(key in coreValue)) {
        merged[key] = value;
        console.error(`  ↳ preserving harper-pro-only ${field} entry: ${key}@${value}`);
      }
    }
    process.stdout.write(JSON.stringify(merged));
  ' "$field" "$pro_before" "$core_value")
  npm pkg set "${field}=${merged}" --json
}

sync_pkg_field dependencies
sync_pkg_field devDependencies
sync_pkg_field overrides
sync_pkg_field optionalDependencies

# One spec per shipped package; see build-tools/DESIGN.md.
node -e '
	const { readFileSync, writeFileSync } = require("node:fs");
	const manifest = JSON.parse(readFileSync("package.json", "utf8"));
	for (const field of ["dependencies", "optionalDependencies"]) {
		for (const name of Object.keys(manifest[field] ?? {})) {
			const spec = manifest.devDependencies?.[name];
			if (spec === undefined) continue;
			console.error(`  ↳ ${field} ${name}: ${manifest[field][name]} -> ${spec} (was also a devDependency)`);
			manifest[field][name] = spec;
			delete manifest.devDependencies[name];
		}
	}
	writeFileSync("package.json", JSON.stringify(manifest, null, "\t") + "\n");
'

if [[ "$SKIP_INSTALL" != "true" ]]; then
  echo -e "\n📦 Installing core deps"
  npm install
else
  echo -e "\n📦 Skipping core deps installation"
fi

echo -e "\n🎉 Synchronized!"
