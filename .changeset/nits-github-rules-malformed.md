---
"@titan-design/github": patch
---

`getBranchRules` throws a named error when a `required_status_checks` rule carries no check list, instead of reading it as no required contexts.
