---
"@titan-design/workflow": patch
---

A replayed authorize step now reads its recorded outcome through a schema instead of a cast, so a malformed record throws a validation error rather than being trusted. Typed-lint cleanup elsewhere in the package changes no behavior.
