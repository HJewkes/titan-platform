#!/usr/bin/env bash
# Index the workspace with codewatch and enforce .codewatch/check.json (the package DAG).
# codewatch is not on npm, so point CODEWATCH_CLI at a built checkout's cli entry.
# Set BASE_REF (e.g. origin/main) to suppress violations that already exist there.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${CODEWATCH_CLI:-$HOME/projects/codewatch/packages/cli/dist/index.js}"
DB="$ROOT/.codewatch/graph.db"
CONFIG="$ROOT/.codewatch/check.json"

if [[ ! -f "$CLI" ]]; then
  echo "codewatch CLI not found at $CLI (set CODEWATCH_CLI)" >&2
  exit 2
fi

rm -f "$DB" "$DB-shm" "$DB-wal"
cd "$ROOT"
node "$CLI" graph index packages products --db "$DB" --ref head --no-churn

if [[ -n "${BASE_REF:-}" ]]; then
  BASELINE_DIR="$ROOT/.codewatch/baseline"
  rm -rf "$BASELINE_DIR"
  git worktree prune
  git worktree add --detach "$BASELINE_DIR" "$BASE_REF" >/dev/null
  trap 'git worktree remove --force "$BASELINE_DIR" >/dev/null 2>&1 || true' EXIT
  node "$CLI" graph index "$BASELINE_DIR/packages" "$BASELINE_DIR/products" --db "$DB" --ref baseline --no-churn
  exec node "$CLI" graph check --db "$DB" --config "$CONFIG" --snapshot head --baseline baseline
fi

exec node "$CLI" graph check --db "$DB" --config "$CONFIG" --snapshot head
