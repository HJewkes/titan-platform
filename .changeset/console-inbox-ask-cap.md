---
"titan-console": minor
"@titan-design/owner-queue": minor
---

Cap a seat at five open owner asks and key a deposit's blocking on its `unblocksNow` line (TP-4353). `inbox.deposit` (and so `titan-console inbox file`) refuses an asker's sixth open deposit with 429, listing the five open ids to merge or withdraw; answered and withdrawn deposits do not count, and the owner (`hjewkes` or `owner`) is never capped. Deposits gain an optional `unblocksNow`: one trimmed line of at most 200 characters saying what the answer unblocks right now. A deposit without it lists under Planning, never Blocking.

Automation askers named in `TITAN_CONSOLE_CAP_EXEMPT_ASKERS` (a comma list of exact names, `titan-factory` when unset) skip the five-ask cap; their same-key alarms still fold into one item.
