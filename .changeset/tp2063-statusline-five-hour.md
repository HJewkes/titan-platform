---
"@titan-design/anthropic-account": patch
---

`status --statusline` renders from `readAccounts`, so each cell comes from `mergeAccountReadings`. That merge takes the poller's `usage-poll.json` as the reading of record while it is at most 360 seconds old and drops a window whose reset has already passed. A reading that has only `seven_day` now renders, since the usage response no longer carries `five_hour`, and the 5h fields print empty when `five_hour` is absent. The line format is unchanged when both windows are present.
