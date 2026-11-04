---
"@titan-design/factory": patch
---

Shepherd gains a pure visual-tier classifier (TP-4761 S1). It parses the tier policy and the pr-visual artifact with strict schemas, sorts every changed path through one ordered row table that defaults to rendered, and builds tier 1 only from a proof that covers every path; anything unproven is tier 2 with a reason. Nothing calls it yet.
