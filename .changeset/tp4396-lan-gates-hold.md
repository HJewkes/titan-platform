---
"@titan-design/factory": minor
---

Shepherd gains a `lan-gates` hold class for gates that cannot run in GitHub Actions (TP-4396). The reason names the gates, `lan-gates: <gate>, <gate>; <detail>`. `shepherd hold` refuses with exit 65 an empty or badly spelled list, or one that names a gate never declared. Migration 47 adds the gate catalog and an append-only evidence table. The merge wait releases the hold at the PR's head, as read just then, once every named gate's newest record at exactly that head is green.
