#!/usr/bin/env bash
# The fix-proof workflow's glue between its three jobs. Two exec jobs build and test one side each and pass encoded
# reports on as job outputs; the judge job decodes them with code built from the merge base alone and prints the one
# fix-proof/v1 line Shepherd reads. A head process cannot reach another job's VM, outputs or log, so the judge's line
# cannot be forged from the head the way a single job's could.
#
#   exec <base|head> <runner> <repo> <base> <head> <out>  run one side, writing <name>.report files into <out>
#   emit <base|head> <out>                                copy those files into $GITHUB_OUTPUT as report (and rerun)
#   receive <dir>                                         write REPORT_BASE, REPORT_BASE_RERUN, REPORT_HEAD into <dir>
#   judge <runner> <repo> <base> <head> <dir>             print the verdict from the reports in <dir>, or an error
#                                                         line when FIX_PROOF_REFUSED holds a reason
#   merge-base <repo> <base> <head>                       write sha=<merge base> into $GITHUB_OUTPUT, or refused=<reason>
#                                                         when env BASE_REF is not env DEFAULT_BRANCH
#
# A stacked PR's base is a parent branch any agent can push, so a runner from its merge base would take the plan's
# config and the judge's own source from the parent. merge-base therefore refuses any base but the default branch.
#
# The runner always comes from the merge base. A merge base that predates the split has no dist/judge.js, so every
# mode treats it as "nothing to prove with": exec writes skipped markers and judge prints a skipped line.
#
# exec base runs the head's tests on the merge base, so it hands the runner a sandbox user: a system account with no
# sudo, which the runner drops to inside a fresh PID namespace. Nothing those tests start can then outlive vitest or
# write the reports, this script or $GITHUB_OUTPUT. A merge-base runner without sandbox support, or a sandbox this
# job cannot set up, yields error markers for both base reports, never an unsandboxed run.
set -euo pipefail

readonly SKIPPED="skipped: no runner at merge base"
# Leaves the runner, not the exec job's 15-minute timeout, to report an overrun.
readonly EXEC_BUDGET_MS=780000
# The judge receives each report as one environment string, and Linux refuses to start a process holding a string
# over 128 KiB (MAX_ARG_STRLEN). A larger report becomes an error marker the judge can read instead.
readonly MAX_OUTPUT_BYTES=120000
readonly SANDBOX_USER=fix-proof-sandbox
# Root-owned and outside the runner's home, so the sandbox user can run what is here but not change it. Tests point it
# at a temp dir.
readonly SANDBOX_TOOLS=${FIX_PROOF_SANDBOX_TOOLS:-/opt/fix-proof-sandbox}

usage() {
  echo "usage: fix-proof-run.sh exec|emit|receive|judge|merge-base ... (see the header)" >&2
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

# tsup splits shared code into chunks, so the flag's literal sits in a chunk beside bin.js rather than in bin.js.
has_sandbox() {
  grep -qsF -- '"sandbox-user"' "$1"/packages/fix-proof/dist/*.js
}

# Prints why the sandbox user cannot be used, or nothing when it can.
sandbox_problem() {
  local tool
  for tool in sudo timeout unshare setpriv; do
    command -v "$tool" >/dev/null || { echo "$tool is missing"; return; }
  done
  sudo -n true >/dev/null 2>&1 || { echo "the job cannot sudo"; return; }
  if ! id -u "$SANDBOX_USER" >/dev/null 2>&1; then
    sudo -n useradd --system --no-create-home --shell /usr/sbin/nologin "$SANDBOX_USER" >&2 || { echo "useradd failed"; return; }
  fi
  # setpriv --init-groups hands the sandbox every group the user is in, and a group such as docker reaches root.
  [ "$(id -G "$SANDBOX_USER")" = "$(id -g "$SANDBOX_USER")" ] || { echo "$SANDBOX_USER has supplementary groups"; return; }
  if sudo -n -u "$SANDBOX_USER" sudo -n true >/dev/null 2>&1; then echo "$SANDBOX_USER can sudo"; return; fi
  stage_pnpm || echo "staging pnpm for the sandbox failed"
}

# pnpm/action-setup installs pnpm under the runner's home, which the sandbox user cannot traverse, so vitest's
# `pnpm exec` exits 127 there. A root-owned copy in SANDBOX_TOOLS, first on PATH, serves it instead; node already
# lives in the world-readable tool cache.
stage_pnpm() {
  local pnpm node package bin
  pnpm=$(command -v pnpm) && node=$(command -v node) || return 1
  # action-setup's .bin sits beside node_modules/pnpm. pnpm's exports map hides package.json from require.resolve.
  package=$(cd "$(dirname "$pnpm")/../pnpm" && pwd -P) &&
    bin=$(node -p 'JSON.parse(fs.readFileSync(process.argv[1], "utf8")).bin.pnpm' "$package/package.json") || return 1
  [ -n "$bin" ] && [ "$bin" != undefined ] && [ -f "$package/$bin" ] || return 1
  # shellcheck disable=SC2016 # expanded by the root shell, from its own arguments
  sudo -n sh -c '
    set -e
    rm -rf "$1" && mkdir -p "$1/bin" && cp -RL "$2" "$1/pnpm"
    printf "#!/bin/sh\nexec %s %s \"\$@\"\n" "$3" "$1/pnpm/$4" >"$1/bin/pnpm"
    chmod -R a+rX,go-w "$1" && chmod 755 "$1/bin/pnpm"
  ' sh "$SANDBOX_TOOLS" "$package" "$node" "$bin"
}

write_markers() {
  local out=$1 message=$2 name
  shift 2
  mkdir -p "$out"
  for name in "$@"; do marker "$message" >"$out/$name.report"; done
}

# Prints why the base side cannot run sandboxed, or nothing when it can.
base_sandbox_problem() {
  if has_sandbox "$1"; then sandbox_problem; else echo "the merge-base runner has no sandbox support"; fi
}

exec_side() {
  local side=$1 runner=$2 repo=$3 base=$4 head=$5 out=$6 names problem path=$PATH
  local -a sandbox=()
  names=$(side_reports "$side")
  if ! has_judge "$runner"; then
    echo "fix-proof: no exec/judge runner at merge base ($runner)" >&2
    write_markers "$out" "$SKIPPED" $names
    return 0
  fi
  if [ "$side" = base ]; then
    problem=$(base_sandbox_problem "$runner")
    if [ -n "$problem" ]; then
      echo "fix-proof: base side not run: $problem" >&2
      write_markers "$out" "base: sandbox unavailable: $problem" $names
      return 0
    fi
    { unshare --version && setpriv --version; } >&2 || true
    sandbox=(--sandbox-user "$SANDBOX_USER")
    path="$SANDBOX_TOOLS/bin:$PATH"
  fi
  PATH=$path node "$runner/packages/fix-proof/dist/bin.js" exec --side "$side" --repo "$repo" --base "$base" --head "$head" --out "$out" \
    --budget-ms "$EXEC_BUDGET_MS" "${sandbox[@]}"
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

# The error verdict printed without a runner. Quotes, backslashes and control characters are dropped from the
# message so the line stays one valid JSON object.
error_line() {
  local message=${3//[\"\\[:cntrl:]]/}
  printf 'fix-proof/v1 {"head":"%s","mergeBase":"%s","verdict":"error","counts":{"reproduces":0,"passes-on-base":0,"new-api":0,"fails-on-head":0,"not-run":0},"notCollected":[],"deletedTests":[],"configEdited":false,"tests":[],"truncated":false,"error":"%s"}\n' "$1" "$2" "$message"
}

judge() {
  local runner=$1 repo=$2 base=$3 head=$4 dir=$5
  if [ -n "${FIX_PROOF_REFUSED:-}" ]; then
    echo "fix-proof: refused: $FIX_PROOF_REFUSED" >&2
    error_line "$head" "$base" "$FIX_PROOF_REFUSED"
    return 0
  fi
  if ! has_judge "$runner"; then
    echo "fix-proof: no judge at merge base ($runner)" >&2
    error_line "$head" "$base" "$SKIPPED"
    return 0
  fi
  node "$runner/packages/fix-proof/dist/judge.js" --repo "$repo" --base "$base" --head "$head" \
    --base-report "$dir/base.report" --base-rerun-report "$dir/base-rerun.report" --head-report "$dir/head.report"
}

# A branch name as the refusal may show it: anything outside a plain ref alphabet becomes ?, so the reason cannot
# add a line to $GITHUB_OUTPUT.
shown_ref() {
  local ref=${1//[^A-Za-z0-9._\/+-]/?}
  printf '%s' "${ref:-<none>}"
}

merge_base() {
  local repo=$1 base=$2 head=$3 base_ref=${BASE_REF:-} default=${DEFAULT_BRANCH:-}
  if [ -z "$base_ref" ] || [ -z "$default" ] || [[ $base_ref == *$'\n'* ]] || [ "$base_ref" != "$default" ]; then
    printf 'refused=fix-proof runs only against the default branch: base %s is not %s\n' \
      "$(shown_ref "$base_ref")" "$(shown_ref "$default")" >>"${GITHUB_OUTPUT:?}"
    return 0
  fi
  local sha
  sha=$(git -C "$repo" merge-base "$base" "$head")
  printf 'sha=%s\n' "$sha" >>"${GITHUB_OUTPUT:?}"
}

mode=${1:-}
[ $# -gt 0 ] && shift
case $mode in
  exec) [ $# -eq 6 ] || usage; exec_side "$@" ;;
  emit) [ $# -eq 2 ] || usage; emit "$@" ;;
  receive) [ $# -eq 1 ] || usage; receive "$@" ;;
  judge) [ $# -eq 5 ] || usage; judge "$@" ;;
  merge-base) [ $# -eq 3 ] || usage; merge_base "$@" ;;
  *) usage ;;
esac
