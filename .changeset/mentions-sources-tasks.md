---
'@titan-design/active-work': minor
---

The workspace edge pass now writes `mentions` edges from source markdown bodies and from each task's title, done_when and notes, not only from notes. A source body over 256 KB is skipped and counted as `oversizedSources` in the refresh summary.
