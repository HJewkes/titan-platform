---
"@titan-design/explainer": minor
---

Seed the script stage from a stored draft (TP-4516). `explainer run --from script --pin seed-draft=<sha>` skips the draft call and its plan retry: it lints the stored draft at $0, then runs only the repair rounds its failing rows need, so a seed that passes every gate makes no model call. The seed's sha is part of the script stage key (script `x22`). The script stage now notes each call's kind and spend (`calls: draft $…; plan-retry $…; repair-1 $…`).
