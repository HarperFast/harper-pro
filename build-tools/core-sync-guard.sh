#!/usr/bin/env bash
# Reports changes the committed core pointer has that moving core to <candidate-sha> would drop
# (build-tools/DESIGN.md, "A core sync warns when it drops content the committed pointer has").
# Usage: core-sync-guard.sh <submodule-dir> <committed-sha> <candidate-sha> [<remote>]
# Prints a Markdown warning on stdout when the candidate may lack some of them, nothing otherwise.
# Advisory: always exits 0, so it never stops a sync. Never changes the submodule's HEAD, index or
# files; it may fetch objects.
set -u
dir="$1" before="$2" after="$3" remote="${4:-origin}"

git_core() { git -C "$dir" "$@"; }

warn() {
  echo "## ⚠️ This core sync may drop changes the previous core pointer had"
  echo
  echo "\`core\` moves from \`$before\` to \`$after\`. $1"
  echo
  echo "Detection is the tests (\`unitTests/replication/originFloorSeqRow.test.mjs\`, the Cluster Integration shards); this warning never stops the sync."
  if [[ -n "${commits:-}" ]]; then
    echo
    echo "Commits on the previous pointer that \`$after\` does not contain:"
    echo
    echo '```'
    echo "$commits"
    echo '```'
  fi
  if [[ -n "${stat:-}" ]]; then
    echo
    echo "$2"
    echo
    echo '```'
    echo "$stat"
    echo '```'
  fi
  exit 0
}

undecidable() {
  warn "Whether it keeps them could not be determined ($1); compare by hand with \`git -C core diff $after...$before\`."
}

ancestor() {
  git_core merge-base --is-ancestor "$before" "$after"
  local rc=$?
  [[ $rc -le 1 ]] || undecidable "merge-base exit $rc"
  return $rc
}

[[ "$before" == "$after" ]] && exit 0
ancestor && exit 0
if [[ "$(git_core rev-parse --is-shallow-repository)" == "true" ]]; then
  git_core fetch --quiet --unshallow "$remote" >&2 || undecidable "could not unshallow $dir"
  ancestor && exit 0
fi

# A squash- or rebase-merged companion is not an ancestor but adds nothing when merged back in.
commits=$(git_core log --oneline --no-decorate -n 50 "$after..$before")
errors=$(mktemp)
trap 'rm -f "$errors"' EXIT
output=$(git_core merge-tree --write-tree "$after" "$before" 2>"$errors")
merge_rc=$?
[[ $merge_rc -le 1 ]] || undecidable "merge-tree exit $merge_rc, needs git >= 2.38: $(cat "$errors")"
merged=${output%%$'\n'*}
if [[ $merge_rc -eq 0 && "$merged" == "$(git_core rev-parse "$after^{tree}")" ]]; then
  exit 0
fi

stat=$(git_core diff --stat=100 --stat-count=100 "$after" "$merged")
if [[ $merge_rc -eq 0 ]]; then
  warn "The previous pointer is not on the tracked branch, and the new one lacks some of its changes." \
    "What merging the previous pointer back in would add (the content this sync drops):"
fi
warn "The previous pointer is not on the tracked branch, and merging it into the new one conflicts, so its changes cannot be shown to be kept (a companion that merged with revisions looks like this)." \
  "Merging the previous pointer back in, with the conflicted files:"
