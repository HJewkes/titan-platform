---
"@titan-design/review-panel": minor
---

Add `aggregate(plan, results, input)`, the fail-closed panel verdict for one head. Any blocking FIX_FIRST blocks, MERGE needs every blocking member's MERGE at the head, and a missing blocking member is `no-verdict` or `timeout`, never MERGE. Advisory findings ride along only when their `path:line` citations exist at the head (checked with `@titan-design/evidence`), findings are bounded per member, and `satisfiesG10` is false when any member is degraded. Exports the `MemberResult` and `AggregateInput` types.
