---
"@titan-design/review-panel": minor
---

Add the `scope_untagged` and `repeated_finding` refusals (TP-3735 S5) and export their `ScopeRefusal` type. Their correction prompt tells a scoped fix-round FIX_FIRST which rule it broke (an out-of-range item with no `Important:` and `Class:` line, or a restated earlier finding) and that its reply stands as written, within `MAX_CORRECTION_PROMPT_CHARS`.
