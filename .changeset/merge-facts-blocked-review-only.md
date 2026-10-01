---
"@titan-design/factory": patch
---

Shepherd's merge evidence treats a `blocked` PR as merge-tree-clean when the only block is a review rule the merge path bypasses, read through the same `reviewRulesBypassable` as the land ci-wait. An unreadable ruleset or a conflicting PR still gates.
