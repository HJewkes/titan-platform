---
"@titan-design/explainer": patch
---

A four-digit id after PR, pull request, ticket, issue, `#` or `TP-` is spelled as digit pairs ("PR twenty-three twenty-four", "TP forty-one oh three"), not as a cardinal; the style is the one `ID_STYLE` constant in `spoken-numbers.ts` (TP-4115). The rewrite stage's `no-new-l0-error` gate now compares the rewrite with the spelled draft (`spellScript`, now exported from `rewrite-pass.ts`), so spelling alone no longer reads as a new Q-V9 failure.
