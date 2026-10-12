---
"@titan-design/tool-guard": minor
---

Add preference row R175: in an agent worktree (`PreferenceContext.agentWorktree`, default false), a bare full-suite run (`pnpm test`, `npm test`, `vitest run`, `pnpm vitest run`, `pnpm exec vitest run`, `npx vitest run` with no path argument) is told to run `pnpm test:affected` or named test files instead (TP-1727 slice 2).
