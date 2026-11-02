---
"@titan-design/active-work": patch
---

Narrow `gh` wire JSON and stored JSON columns with zod instead of `as` casts. A malformed element in a `gh pr list` answer or a malformed preserved row is now skipped and reported rather than thrown or passed through, and a note whose stored tags do not parse is indexed as untagged.
