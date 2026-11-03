---
"@titan-design/anthropic-account": patch
---

`status --statusline` reads a reading that has only `seven_day`, since the usage response no longer carries `five_hour`. It prefers the poller's `usage-poll.json` while it is at most 360 seconds old, drops a reading whose `seven_day` window has already reset, and prints empty 5h fields when `five_hour` is absent. `readUsage` gains `pollerFirstSeconds` and `dropReset` options. The line format is unchanged when both windows are present.
