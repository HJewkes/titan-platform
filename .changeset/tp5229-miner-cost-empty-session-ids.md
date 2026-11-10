---
'@titan-design/active-work': patch
---

`miner cost --session-ids @file` now exits with a usage error when the file holds no ids, instead of returning a silently empty report.
