---
"@titan-design/active-work": patch
---

The session-index scheduler now caps how long its memory-pressure gate may hold. After `maxHoldMs` (default 30 minutes) of continuous hold it lets one pass through, restarts the hold clock, and reports the release as `hold cap <n> ms reached`.
