---
"@titan-design/anthropic-account": minor
---

Add `mergeAccountReadings` and the `AccountUsage` type to the pure entry: one account's usage from its poller and status-line readings. A fresh poller (≤ 360 s) is the reading of record; status lines may lend a missing window or raise one inside the same window; a window whose every reset has passed reads as rolled to 0; readings are aged by when their rate_limits were observed.
