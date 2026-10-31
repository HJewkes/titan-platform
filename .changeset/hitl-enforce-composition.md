---
"@titan-design/hitl": patch
---

The gate payload check now enforces `allOf`, `not`, local `$ref` (to the root, `$defs` or `definitions`) and `prefixItems` elements. A remote or unresolvable reference, or a reference cycle that steps into no property or element, makes the schema unreadable, so the gate refuses every payload.
