---
"@titan-design/factory": patch
---

The redeploy and post-merge recipe files no longer import `node:child_process` or `node:fs`, read `Date`, `process` or timers, or import their adapter modules. Their process, filesystem, clock and environment code moved unchanged into `redeploy-adapter.ts` and `post-merge-adapter.ts`, and the code that builds the routes (`workflows.ts`, `main-watch-ports.ts`, `deploy-pacer-sweep.ts`, `land-pr.ts`, `chore-main.ts`) passes it in. The recipe lint now rejects value imports of those two adapters. No step id, order or recorded input or output changes.
