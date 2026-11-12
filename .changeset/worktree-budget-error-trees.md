---
"@titan-design/worktree": minor
---

Pass the counted trees to the `budgetError` hook as a fourth argument, `trees: readonly string[]`. They are the paths behind `allocated`, filtered by `allocationGroup`, so a host can name the holders without re-listing worktrees. Existing three-argument hooks still compile.
