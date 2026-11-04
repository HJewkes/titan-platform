---
"@titan-design/factory": patch
---

Shepherd gains a pure visual-tier classifier (TP-4761 S1). Given the visual-glob paths a head changed, it sorts each into harness, rendering, test, story, logic or rendered, and returns tier 1 (non-rendering, or no pixel diff) or tier 2 with a reason. A rendered path with no pixel read of the pr-visual artifact counts as tier 2. Nothing calls it yet.
