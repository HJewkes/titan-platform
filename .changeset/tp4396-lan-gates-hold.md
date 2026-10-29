---
"@titan-design/factory": minor
---

Shepherd gains a `lan-gates` hold class for gates that cannot run in GitHub Actions (TP-4396). The reason names the gates, `lan-gates: <gate>, <gate>; <detail>`. `shepherd hold` refuses with exit 65 an empty or badly spelled list, or one that names a gate never declared. Migration 47 adds the gate catalog and an append-only evidence table. The hold is never lifted by evidence: a merge read at the PR's head, as read just then, passes it only while every named gate's newest record at exactly that head is green, so a later push is held again.
