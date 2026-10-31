---
"@titan-design/evals": minor
---

The implement-task selector now accepts npm repos: `hasPnpmLock` became `hasSupportedLock`, true for `pnpm-lock.yaml` or `package-lock.json` at the base. New `cloneFacts(gitFor)` answers the selector's lockfile, merge-parent and test-change questions from a clone with git and the fix-proof plan. `briefOf` and `planHiddenTests` are exported.
