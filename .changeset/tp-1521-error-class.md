---
"@titan-design/factory": patch
---

Shepherd keeps one errorClass, in shepherd/error-class.ts: merge-facts imports it, and it refuses an identifier-shaped error name that looks like a credential (a GitHub token prefix, a JWT head or a 32+ hex run). failureOf reports an HTTP status only in 100-599, and the reviewer dispatch's console line no longer fails the step when an error's message getter throws.
