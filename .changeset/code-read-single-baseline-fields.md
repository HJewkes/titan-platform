---
"@titan-design/code-read": patch
---

Declare the baseline result fields once in `query/schemas.ts` and type `baselineFields()` from them, and read a rule's default severity through one `ruleSeverity()` helper. No behaviour change; the contract lock is unchanged.
