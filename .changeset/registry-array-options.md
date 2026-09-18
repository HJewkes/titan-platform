---
"@titan-design/registry": minor
---

CLI options for array-typed fields now repeat instead of taking a single comma-separated
value: `--tag a --tag b` yields `["a", "b"]`, with each element coerced by the array's
element kind. Adds `collectOptionParser`, commander's accumulator for these fields, and
`arrayElementKind` for schema introspection. `coerceCliValue` no longer splits a
comma-separated string for an array field.
