---
"@titan-design/fix-proof": minor
---

Add head mode for generated mutants: `execHeadMutants` runs `HeadMutation`s (a `Mutation` with no `kills`) against head in a detached worktree, one owning-package suite per mutant with M + P rebuilds, and `classifyHeadRun` reads each run as `survived`, `caught`, `caught-error`, `load-error` or `timeout`. Mutations left when the budget runs out are listed in `unrun`. `checkMutation` now accepts a `HeadMutation`.
