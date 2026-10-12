#!/usr/bin/env bash
# The fix-proof workflow's glue between its three jobs. Two exec jobs build and test one side each and pass encoded
# reports on as job outputs; the judge job decodes them with code built from the merge base alone and prints the one
# fix-proof/v1 line Shepherd reads. A head process cannot reach another job's VM, outputs or log, so the judge's line
# cannot be forged from the head the way a single job's could.
#
#   exec <base|head> <runner> <base> <head> <out>       run one side, writing <name>.report files into <out>
#   emit <base|head> <out>                              copy those files into $GITHUB_OUTPUT as report (and rerun)
#   receive <dir>                                       write REPORT_BASE, REPORT_BASE_RERUN, REPORT_HEAD into <dir>
#   judge <runner> <repo> <base> <head> <dir>           print the verdict from the reports in <dir>
#
# The runner always comes from the merge base. A merge base that predates the split has no dist/judge.js, so every
# mode treats it as "nothing to prove with": exec writes skipped markers and judge prints a skipped line.
set -euo pipefail

readonly SKIPPED="skipped: no runner at merge base"
# Leaves the runner, not the exec job's 15-minute timeout, to report an overrun.
readonly EXEC_BUDGET_MS=780000
# The judge receives each report as one environment string, and Linux refuses to start a process holding a string
# over 128 KiB (MAX_ARG_STRLEN). A larger report becomes an error marker the judge can read instead.
readonly MAX_OUTPUT_BYTES=120000

usage() {
  echo "usage: fix-proof-run.sh exec|emit|receive|judge ... (see the header)" >&2
  exit 64
}

# The same envelope transport.ts encodeError writes: gzipped JSON, base64 with no space or newline.
marker() {
  printf '{"v":1,"error":"%s"}' "$1" | gzip -cn | base64 | tr -d '\n'
}

side_reports() {
  case $1 in
    base) echo "base base-rerun" ;;
    head) echo "head" ;;
    *) usage ;;
  esac
}

has_judge() {
  [ -f "$1/packages/fix-proof/dist/bin.js" ] && [ -f "$1/packages/fix-proof/dist/judge.js" ]
}

exec_side() {
  local side=$1 runner=$2 base=$3 head=$4 out=$5 name
  local names
  names=$(side_reports "$side")
  if ! has_judge "$runner"; then
    echo "fix-proof: no exec/judge runner at merge base ($runner)" >&2
    mkdir -p "$out"
    for name in $names; do marker "$SKIPPED" >"$out/$name.report"; done
    return 0
  fi
  node "$runner/packages/fix-proof/dist/bin.js" exec --side "$side" --base "$base" --head "$head" --out "$out" \
    --budget-ms "$EXEC_BUDGET_MS"
}

# Prints the report to pass on, or a marker saying why it cannot be: a value with anything outside the base64
# alphabet could add lines to $GITHUB_OUTPUT.
output_value() {
  local file=$1 name=$2 value
  if [ ! -f "$file" ]; then marker "$name: the exec job wrote no report"; return; fi
  if [ "$(wc -c <"$file")" -gt "$MAX_OUTPUT_BYTES" ]; then
    marker "$name: report over $MAX_OUTPUT_BYTES bytes, too large to pass to the judge"
    return
  fi
  value=$(cat "$file")
  if [[ ! $value =~ ^[A-Za-z0-9+/=]*$ ]]; then marker "$name: report is not base64"; return; fi
  printf '%s' "$value"
}

emit() {
  local side=$1 out=$2 name key
  for name in $(side_reports "$side"); do
    key=report
    [ "$name" = base-rerun ] && key=rerun
    printf '%s=%s\n' "$key" "$(output_value "$out/$name.report" "$name")" >>"${GITHUB_OUTPUT:?}"
  done
}

# The workflow passes each output through toJSON, so a value the head job forged with newlines still echoes as one
# line in the step's env block. Stripping the quotes gives back plain base64; anything escaped fails to decode.
receive_one() {
  local value=${!1-}
  value=${value#\"}
  value=${value%\"}
  if [ -n "$value" ]; then printf '%s' "$value" >"$2"; fi
}

receive() {
  mkdir -p "$1"
  receive_one REPORT_BASE "$1/base.report"
  receive_one REPORT_BASE_RERUN "$1/base-rerun.report"
  receive_one REPORT_HEAD "$1/head.report"
}

judge() {
  local runner=$1 repo=$2 base=$3 head=$4 dir=$5
  if ! has_judge "$runner"; then
    echo "fix-proof: no judge at merge base ($runner)" >&2
    printf 'fix-proof/v1 {"head":"%s","mergeBase":"%s","verdict":"error","counts":{"reproduces":0,"passes-on-base":0,"new-api":0,"fails-on-head":0,"not-run":0},"notCollected":[],"deletedTests":[],"configEdited":false,"tests":[],"truncated":false,"error":"%s"}\n' "$head" "$base" "$SKIPPED"
    return 0
  fi
  node "$runner/packages/fix-proof/dist/judge.js" --repo "$repo" --base "$base" --head "$head" \
    --base-report "$dir/base.report" --base-rerun-report "$dir/base-rerun.report" --head-report "$dir/head.report"
}

mode=${1:-}
[ $# -gt 0 ] && shift
case $mode in
  exec) [ $# -eq 5 ] || usage; exec_side "$@" ;;
  emit) [ $# -eq 2 ] || usage; emit "$@" ;;
  receive) [ $# -eq 1 ] || usage; receive "$@" ;;
  judge) [ $# -eq 5 ] || usage; judge "$@" ;;
  *) usage ;;
esac
