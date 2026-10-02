---
"@titan-design/worktree": patch
---

Skip the worktree setup step, with a warning, when the tree's `pnpm-workspace.yaml` is not byte-identical to the one at the trusted base. pnpm 10 ranks that file's `ignorePnpmfile`, `ignoreScripts` and `pnpmfile` keys above the pinned environment, so a branch could otherwise re-enable its pnpmfile hooks and lifecycle scripts during setup.
