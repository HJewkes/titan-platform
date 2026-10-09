---
"@titan-design/factory": minor
---

`serve` stamps each stderr log line with its ISO time, and `/health` adds `startedAt`, `uptimeSeconds`, `restartCount`, `uncleanStartsTotal` and `restartsToday`. The counts persist in `serve-starts.json` in the serve state directory; a start that finds a stale daemon pid file counts as unclean, and a start refused because a server already runs is not counted.
