---
"@titan-design/factory": patch
---

Check a scoped fix round's FIX_FIRST behind `shepherd.review.scopeCheck` (TP-3735 S5), off when absent. `sh-scope-check:<head>` counts blocking items outside the fix's ranges with no `Important:` and `Class:` line, and items that restate an open finding. `shadow` records the counts; `on` asks the reviewer for one correction and keeps a second miss as written. Review stats store the counts, report them per week, and count a `scopeShadow` round as full.
