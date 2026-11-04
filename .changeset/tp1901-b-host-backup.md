---
"@titan-design/titan": minor
---

titan versions the nightly restic backup as `scripts/host-backup.sh`, configured by `~/.config/titan/backup.env` (`RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`, `BACKUP_PATHS`, `BACKUP_EXCLUDES`, optional `BACKUP_MOUNT`), and renders its `titan-host-backup.service` and `.timer` (02:30, Persistent=true). Nothing installs them yet.
