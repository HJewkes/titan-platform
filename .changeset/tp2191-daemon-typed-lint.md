---
"@titan-design/daemon": patch
---

Typed-lint burn-down: the daemon narrows caught errors, parsed JSON and the hono environment instead of asserting their types. A pid-file meta with wrongly typed fields now reads as the default for that field, and a health probe whose body is not an object reads as no answer.
