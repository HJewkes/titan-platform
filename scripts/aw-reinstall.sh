#!/usr/bin/env bash
# Reinstalls active-work from origin/main: build in a staging dir, re-point the bins, restart the daemon, log timings.
# Usage: aw-reinstall.sh [--dry-run]   (--dry-run prints each step and changes nothing)
# Env: AW_REPO (checkout to fetch from, default ~/projects/titan-platform), AW_STAGE_ROOT, AW_BIN_DIR, AW_LOG.
set -euo pipefail

DRY=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  *) echo "usage: aw-reinstall.sh [--dry-run]" >&2; exit 2 ;;
esac

REPO="${AW_REPO:-$HOME/projects/titan-platform}"
STAGE_ROOT="${AW_STAGE_ROOT:-$HOME/.local/share/aw-reinstall}"
BIN_DIR="${AW_BIN_DIR:-$HOME/.local/bin}"
LOG="${AW_LOG:-$HOME/.local/state/active-work/aw-reinstall.log}"
PRODUCT=products/active-work

step() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else echo "+ $*"; "$@"; fi; }

note_open() { if [ "$DRY" = 1 ]; then echo "[dry-run] time: $BIN_DIR/active-work open titan-platform"; fi; }

# Wall seconds of `active-work open titan-platform`, or "failed" so a broken install still gets a log line.
time_open() {
  if [ "$DRY" = 1 ]; then echo "dry"; return; fi
  local start end
  start=$(date +%s.%N)
  "$BIN_DIR/active-work" open titan-platform >/dev/null 2>&1 || { echo failed; return; }
  end=$(date +%s.%N)
  awk -v s="$start" -v e="$end" 'BEGIN { printf "%.2fs", e - s }'
}

# Explicit `corepack pnpm@<pin>` runs the version the staged tree pins whatever pnpm leads PATH, with no host install,
# and does not depend on cwd (corepack reads packageManager from cwd, but the unit's cwd is not the stage).
pinned_pnpm() {
  local pm
  pm=$(git -C "$REPO" show origin/main:package.json 2>/dev/null | sed -n 's/.*"packageManager": *"\(pnpm@[^"+]*\).*/\1/p' | head -n 1)
  if [ -n "$pm" ]; then echo "$pm"; elif [ "$DRY" = 1 ]; then echo "pnpm@<packageManager pin>"; else echo "no pnpm packageManager pin in origin/main" >&2; return 1; fi
}

note_open
before=$(time_open)
step git -C "$REPO" fetch origin main
PNPM=$(pinned_pnpm)
echo "pnpm: corepack $PNPM"
if [ "$DRY" = 1 ]; then sha="<origin/main sha>"; else sha=$(git -C "$REPO" rev-parse --verify origin/main); fi
stage="$STAGE_ROOT/$sha"
echo "stage: $stage"
step mkdir -p "$stage"
if [ "$DRY" = 1 ]; then
  echo "[dry-run] git -C $REPO archive origin/main | tar -x -C $stage"
else
  git -C "$REPO" archive "$sha" | tar -x -C "$stage"
fi
step corepack "$PNPM" --dir "$stage" install --frozen-lockfile
step corepack "$PNPM" --dir "$stage" --filter "@titan-design/active-work..." build
step chmod +x "$stage/$PRODUCT/dist/cli.js" "$stage/$PRODUCT/dist/aw.js"
step mkdir -p "$BIN_DIR"
step ln -sfn "$stage/$PRODUCT/dist/cli.js" "$BIN_DIR/active-work"
step ln -sfn "$stage/$PRODUCT/dist/aw.js" "$BIN_DIR/aw"
step systemctl --user restart active-work.service
note_open
after=$(time_open)

line="$(date -u +%FT%TZ) sha=$sha before=$before after=$after"
echo "$line"
if [ "$DRY" = 1 ]; then echo "[dry-run] append to $LOG"; else mkdir -p "$(dirname "$LOG")"; echo "$line" >> "$LOG"; fi
