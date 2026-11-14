---
"@titan-design/session-miner": patch
---

Read ticket-scorecard task files, archive included, through `@titan-design/pm/node`. The scorecard now also reads `.yaml` task files, and a file that fails to parse no longer counts toward the newest-mtime watermark.
