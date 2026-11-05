---
"@titan-design/active-work": patch
---

`context.related` with a `trigger` no longer serves hits from the charter's `human_only_initiatives` (TP-4140). When the charter is unreadable, a triggered call serves only hits from its own `initiative` and reports a `charter` degradation. Calls without a trigger are unchanged.
