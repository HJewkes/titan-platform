---
---

Test-only: tool-guard's cost tests count the work the hook does instead of timing it, so load on the runner cannot fail them; millisecond budgets run only under `pnpm --filter @titan-design/tool-guard bench` (TP-4047).
