---
"@titan-design/factory": patch
---

Add the pure old-path freeze rule (TP-3182 S1): A1's frozen roots, which changed files touch them (deletions and moves out are exempt), the `superseded-at` / `survives` carve-out grammar, a fail-closed reader for `milestones.json`, and a verdict that is advisory until M1b exits. Nothing calls it yet.
