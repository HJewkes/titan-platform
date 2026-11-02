---
"@titan-design/active-work": patch
---

Make `task.list` faster on large active roots. It now keeps each parsed task file in memory and re-parses a file only when its mtime, size or inode changes, so a warm `--all-initiatives` list stats files instead of parsing them. It reads with bounded concurrency and applies the status, tag, severity, id and search filters as each task loads. Files stay authoritative, and a direct edit shows on the next call.
