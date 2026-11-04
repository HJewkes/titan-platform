---
"@titan-design/hitl": minor
---

`checkAgainstJsonSchema` parses a stored schema once and refuses whatever it cannot read, unknown keywords included, with one `schema is unreadable` issue. It now takes `unknown`. Boolean schemas follow JSON Schema, and only an `undefined` schema means a gate has none.
