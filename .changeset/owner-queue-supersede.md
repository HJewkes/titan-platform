---
"@titan-design/owner-queue": minor
---

Add `supersede(items, heads?)` and `stackContext(items, stacks)`. `supersede` withdraws open, answered or decided items pinned to a PR head other than the live one (`heads[pr]`, else the newest item's head) as `new-head:<sha>`, keeping their answers so an old change request stays readable as context without blocking a ship. `stackContext` gives each item on a stacked PR its base chain as context and orders it after the items on those bases.
