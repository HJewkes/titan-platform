---
"titan-console": minor
---

Log every loading state the owner sees as a wait (TP-4755). Each spinner, skeleton and busy action button reports the view, the commands in flight, the milliseconds, cold or refetch, and whether it waited on a write; a background refetch that shows no loader writes nothing. Calls through the answer source (inbox actions, round submits) are also timed as action rows. The perf tab ranks waits by total owner seconds per command with p50, p95 and budget breaches, `perf.waits` serves the ranking, and `titan-console perf waits [--top <n>] [--window <15m|24h|7d>] [--json]` prints it from the day files.
