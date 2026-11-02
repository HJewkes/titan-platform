---
"@titan-design/session-analytics": minor
"@titan-design/session-miner": minor
---

Add the daily friction audit. session-analytics gains `readWorkerReports`, which reads agent-chat's `Status:` report messages with each worker's last spawn, and `frictionDailyReport`, which takes each report's `Friction:` line (falling back to labelled `Concerns:` and blocked lines), buckets the lines by keyword and ranks the clusters by reports and agent-hours, plus `renderFrictionTop`, `renderFrictionMarkdown` and `frictionDeposit` for the day's owner inbox know-item. session-miner gains `titan-miner friction-daily [--since 24h] [--dry-run] [--archive-dir <dir>]`, which archives the raw rows, withdraws the earlier days' items and files today's through `titan-console`, and a daily 14:05 UTC systemd timer in `ops/systemd`.
