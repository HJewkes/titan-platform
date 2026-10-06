---
"@titan-design/factory": patch
---

A coordinator may now resolve a `stuck-behind` gate with `{"decision":"retry"}`, recorded with its agent name. Abandon, every other gate and every other non-owner class stay refused.
