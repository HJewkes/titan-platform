---
"@titan-design/active-work": patch
---

A full session-index pass now hands every discovered transcript to the missing sweep as present, so a sealed transcript the pass skips is never marked `missing` and then restored. This removes the `unvisitedOk`/`restoreUnvisited` workaround (TP-1019).
