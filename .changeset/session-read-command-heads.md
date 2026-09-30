---
"@titan-design/session-read": minor
---

Add `command_heads`, `file_read` and `file_write` signals and export `commandHeads`. A Bash call's signal carries the program and up to two subcommand words of each simple command, plus `>basename` for redirect and `tee` targets, joined by `;` within 256 characters. Read emits `file_read` and Write, Edit, MultiEdit and NotebookEdit emit `file_write`, each with the repo-relative path. `EXTRACT_VERSION` is now 3, so consumers re-extract once.
