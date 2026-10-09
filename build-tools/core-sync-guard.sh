#!/usr/bin/env bash
# Decides whether moving the core submodule from <committed-sha> to <candidate-sha> keeps every
# change the committed pointer has (build-tools/DESIGN.md, "A core sync never removes content").
# Usage: core-sync-guard.sh <submodule-dir> <committed-sha> <candidate-sha>
# Exit 0: safe to apply (or CORE_SYNC_DROP_CONTENT=true overrode a refusal); 1: refused; 2: undecidable.
# Never changes the submodule's HEAD, index or files; it may fetch objects.
set -u
dir="$1" before="$2" after="$3"

git_core() { git -C "$dir" "$@"; }

undecidable() {
  echo "core sync guard: $1" >&2
  exit 2
}

ancestor() {
  git_core merge-base --is-ancestor "$before" "$after"
  local rc=$?
  [[ $rc -le 1 ]] || undecidable "cannot compare $before and $after (merge-base exit $rc)"
  return $rc
}

[[ "$before" == "$after" ]] && exit 0
ancestor && exit 0
# a shallow checkout has no base to merge from, so only this non-ancestor path pays to unshallow
if [[ "$(git_core rev-parse --is-shallow-repository)" == "true" ]]; then
  git_core fetch --quiet --unshallow origin || undecidable "could not unshallow $dir to compare the pointers"
  ancestor && exit 0
fi

# A squash- or rebase-merged companion is not an ancestor but adds nothing when merged back in.
output=$(git_core merge-tree --write-tree "$after" "$before" 2>&1)
merge_rc=$?
[[ $merge_rc -le 1 ]] || undecidable "merge-tree failed (exit $merge_rc): $output"
merged=${output%%$'\n'*}
if [[ $merge_rc -eq 0 ]] && git_core diff --quiet "$after" "$merged"; then
  exit 0
fi

{
  echo
  if [[ $merge_rc -eq 0 ]]; then
    echo "core sync refused: $before is not on the tracked branch, and $after lacks these changes of it:"
  else
    echo "core sync refused: $before is not on the tracked branch, and merging it into $after conflicts, so its changes cannot be shown to be kept:"
  fi
  git_core diff --stat "$after" "$merged"
} >&2
if [[ "${CORE_SYNC_DROP_CONTENT:-}" == "true" ]]; then
  echo "CORE_SYNC_DROP_CONTENT=true: syncing $before -> $after anyway and dropping them." >&2
  exit 0
fi
echo "Merge the core companion PR first and re-run, or set CORE_SYNC_DROP_CONTENT=true to drop them." >&2
exit 1
