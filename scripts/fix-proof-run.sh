#!/usr/bin/env bash
# Runs the fix-proof runner built at the merge base, or prints a skipped fix-proof/v1 line when that build has no bin.
# The runner always comes from the merge base, never from the PR head, so a PR cannot change the code that judges it.
# A merge base can predate the bin entry (the package built, but only dist/index.js came out), so a missing runner
# is "nothing to prove with", not a job failure.
set -euo pipefail

runner_dir=$1
merge_base=$2
head_sha=$3
bin="$runner_dir/packages/fix-proof/dist/bin.js"

if [ ! -f "$bin" ]; then
  echo "fix-proof: no runner at merge base ($bin)" >&2
  printf 'fix-proof/v1 {"head":"%s","mergeBase":"%s","verdict":"error","counts":{"reproduces":0,"passes-on-base":0,"new-api":0,"fails-on-head":0,"not-run":0},"notCollected":[],"deletedTests":[],"configEdited":false,"tests":[],"truncated":false,"error":"skipped: no runner at merge base"}\n' "$head_sha" "$merge_base"
  exit 0
fi

exec node "$bin" run --base "$merge_base" --head "$head_sha"
