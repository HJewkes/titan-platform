---
"@titan-design/session-analytics": minor
---

The session timeline prices 1h cache writes at the 1h rate. `TimelineTokens` gains `cacheWrite5m` and `cacheWrite1h` beside the `cacheWrite` total, filled from session-read's `cacheWriteSplit`, and each request is priced from the split. Before, every cache write was charged at the 5m rate, so a session with 1h writes read lower on the timeline than in `costReport`. A usage row with only the flat total counts as 5m and prices exactly as before, which is the rule `costReport` already uses.
