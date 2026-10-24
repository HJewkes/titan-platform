---
"@titan-design/active-work": patch
---

`context.related` asks the daemon only for workspace freshness. It no longer starts or waits on a transcript delta pass; a changed workspace file waits on a workspace-only refresh within the 800 ms budget.
