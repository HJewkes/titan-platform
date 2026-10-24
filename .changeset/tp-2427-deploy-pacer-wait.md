---
"@titan-design/factory": patch
---

The deploy pacer now says why it holds a deploy. Each sweep that decides to wait logs `deploy pacer: waiting for <sha>: <why> until <time>`, but only when the wanted sha or the reason changes, so a standing wait logs once and a busy-run count that moves logs nothing new. `/health` `deployPending` carries the current wait as `waiting: { why, until }`, and `titan-factory service check` adds `; deploy <sha> waits: <why> until <time>` to its line, with `deployWaitSha`, `deployWaitWhy` and `deployWaitUntil` in `--json` `detail`.
