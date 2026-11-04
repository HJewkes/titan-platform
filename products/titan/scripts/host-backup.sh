#!/usr/bin/env bash
# Nightly restic backup of this host's dev state. Everything host-specific lives in backup.env,
# which this script sources, so arrays and paths with spaces work:
#   RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE  restic reads the password file itself
#   BACKUP_PATHS=(...)                       required, one entry per path
#   BACKUP_EXCLUDES=(...)                    optional restic --exclude patterns
#   BACKUP_MOUNT=/mnt/backups                optional; exit 75 (EX_TEMPFAIL) when it is not mounted
set -euo pipefail

env_file="${TITAN_BACKUP_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/titan/backup.env}"
[[ -r "$env_file" ]] || { echo "host-backup: no config at $env_file" >&2; exit 78; }
# shellcheck source=/dev/null
source "$env_file"

: "${RESTIC_REPOSITORY:?host-backup: RESTIC_REPOSITORY is unset}"
: "${RESTIC_PASSWORD_FILE:?host-backup: RESTIC_PASSWORD_FILE is unset}"
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE
[[ -n "${BACKUP_PATHS+set}" && ${#BACKUP_PATHS[@]} -gt 0 ]] || { echo "host-backup: BACKUP_PATHS is empty" >&2; exit 78; }

if [[ -n "${BACKUP_MOUNT:-}" ]]; then
  mountpoint -q "$BACKUP_MOUNT" || { echo "host-backup: $BACKUP_MOUNT is not mounted" >&2; exit 75; }
fi

excludes=()
for pattern in ${BACKUP_EXCLUDES[@]+"${BACKUP_EXCLUDES[@]}"}; do
  excludes+=(--exclude "$pattern")
done

host="$(hostname)"
restic backup --tag nightly ${excludes[@]+"${excludes[@]}"} "${BACKUP_PATHS[@]}"
restic forget --host "$host" --tag nightly --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

# Written only after both restic steps succeed: the health check alerts when it is older than 26 h.
stamp_dir="$HOME/.local/state/restic"
mkdir -p "$stamp_dir"
date -Is > "$stamp_dir/last-success-${host%%.*}"
