---
"@titan-design/explainer": patch
---

`explainer edit apply` never rewrites an edit whose ledger row is `started`: a plain apply or a second `--start` of the same edit is refused with exit 1, so one save makes one run. `explainer edit check` now runs the template fill (`fillScript`) and the emphasis-target gate on the edited script.
