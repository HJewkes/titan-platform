---
"@titan-design/factory": patch
---

TP-4833: `landPrRoutes` takes the post-merge host (`now`, `env`, `runChore`) as arguments instead of defaulting to `Date.now` and the live adapter; `factoryRoutesFor` fills it from `hostPostMerge()` and `workflows.ts` passes it explicitly. `workflows/land-pr.ts` leaves the recipe capability baseline. No step id, order or recorded input changes.
