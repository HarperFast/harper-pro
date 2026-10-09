#!/usr/bin/env bash
# Decides whether moving the core submodule from <committed-sha> to <candidate-sha> keeps every
# change the committed pointer has (build-tools/DESIGN.md, "A core sync never removes content").
# Usage: core-sync-guard.sh <submodule-dir> <committed-sha> <candidate-sha> [<remote>]
# Exit 0: safe to apply, or a refusal overridden by CORE_SYNC_SUPERSEDED_BY=<sha> (the merge commit of
# the pointer's own pull request, which the candidate must contain) or by CORE_SYNC_DROP_CONTENT=true;
# 1: refused; 2: undecidable.
# Never changes the submodule's HEAD, index or files; it may fetch objects.
set -u
dir="$1" before="$2" after="$3" remote="${4:-origin}"

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
if [[ "$(git_core rev-parse --is-shallow-repository)" == "true" ]]; then
  git_core fetch --quiet --unshallow "$remote" || undecidable "could not unshallow $dir to compare the pointers"
  ancestor && exit 0
fi

# A squash- or rebase-merged companion is not an ancestor but adds nothing when merged back in.
errors=$(mktemp)
trap 'rm -f "$errors"' EXIT
output=$(git_core merge-tree --write-tree "$after" "$before" 2>"$errors")
merge_rc=$?
[[ $merge_rc -le 1 ]] || undecidable "merge-tree failed (exit $merge_rc; needs git >= 2.38): $(cat "$errors")"
merged=${output%%$'\n'*}
if [[ $merge_rc -eq 0 && "$merged" == "$(git_core rev-parse "$after^{tree}")" ]]; then
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
# a merge commit of the pointer's own pull request is never behind the pointer, so one that is cannot be the proof
if [[ -n "${CORE_SYNC_SUPERSEDED_BY:-}" ]] && git_core merge-base --is-ancestor "$CORE_SYNC_SUPERSEDED_BY" "$after" &&
  ! git_core merge-base --is-ancestor "$CORE_SYNC_SUPERSEDED_BY" "$before"; then
  echo "CORE_SYNC_SUPERSEDED_BY: $before's pull request merged as $CORE_SYNC_SUPERSEDED_BY, which $after contains; syncing." >&2
  exit 0
fi
if [[ "${CORE_SYNC_DROP_CONTENT:-}" == "true" ]]; then
  echo "CORE_SYNC_DROP_CONTENT=true: syncing $before -> $after anyway and dropping them." >&2
  exit 0
fi
echo "Merge the core companion PR first and re-run; if it merged with later revisions, re-run with CORE_SYNC_SUPERSEDED_BY=<its merge commit>; CORE_SYNC_DROP_CONTENT=true drops them." >&2
exit 1
