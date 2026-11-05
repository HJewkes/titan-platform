---
"@titan-design/factory": patch
---

Shepherd's merge guard gains the `old-path-untagged` row (TP-3182 S2b). Once `milestones.json` marks M1b exited, a head that changes files under A1's old-path roots merges only when its registered task carries a `superseded-at:<M>` or `survives:<area>` tag, or the owner decides it. Deletions and moves out are exempt. Before M1b exit the verdict, with the registered kind, is recorded in the evidence record and comment and gates nothing.
