---
"@titan-design/code-graph": patch
---

Document the `<anonymous>` segment in symbol ids. An unbound callback, object or class adds one `<anonymous>` segment, and consecutive anonymous scopes collapse to one, so `src/a.ts#App.<anonymous>.onHash` is the id of a function declared inside a callback in `App`. Ids do not change; the README previously said anonymous scopes add no segment. Regression tests pin the rule.
