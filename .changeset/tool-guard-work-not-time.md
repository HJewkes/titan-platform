---
---

Test-only: tool-guard's cost tests count the work the hook does instead of timing it, so load on the runner cannot fail them; millisecond budgets run only under `TOOL_GUARD_BENCH=1 pnpm exec vitest run packages/tool-guard` (TP-4047).
