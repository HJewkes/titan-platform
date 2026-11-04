#!/usr/bin/env bash
# Installs aw-reinstall.service as a systemd --user unit. Run once by the owner; starting it is `systemctl --user start aw-reinstall`.
# Usage: aw-reinstall-install.sh [--dry-run]
set -euo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/ops/systemd/aw-reinstall.service"
DEST="$HOME/.config/systemd/user"

step() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else echo "+ $*"; "$@"; fi; }

step mkdir -p "$DEST"
step install -m 0644 "$SRC" "$DEST/aw-reinstall.service"
step systemctl --user daemon-reload
