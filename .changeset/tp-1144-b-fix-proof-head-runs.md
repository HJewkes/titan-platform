---
"@titan-design/fix-proof": minor
---

Add `headRuns` to `execSide`: the head side installs and builds once, then runs vitest 1 to 5 times and writes `head.report`, `head-2.report` and so on. A count outside that range writes error markers. Export `classifyDecoded` and `reportNames`.
