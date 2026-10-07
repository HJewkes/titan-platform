---
"@titan-design/factory": patch
---

`titan-factory service check` runs on Linux: it reads `systemctl --user show` (MainPID, NRestarts, ExecMainStatus) and reports a crash loop or a dead unit with the same exit codes as on macOS.
