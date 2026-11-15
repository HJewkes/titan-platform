---
"@titan-design/session-read": minor
---

`recoverSession` reports `compactions: { count, lastSummaries }`: how many times the session compacted and the last three compaction summaries, oldest first. A compaction with no summary text is counted but not listed, and compactions copied in from a parent conversation are skipped.
