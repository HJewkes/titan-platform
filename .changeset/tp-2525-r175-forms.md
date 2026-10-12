---
"@titan-design/tool-guard": patch
---

R175 now also flags `pnpm t`, `npm t`, `run-script test`, bare and watch-mode vitest, options after `--` and `pnpm -c test` as whole-suite runs in an agent worktree.
