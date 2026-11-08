---
"@titan-design/factory": patch
---

Split `workflows.ts` into `workflows-deps.ts` (the route-deps interface) and `workflows-routes.ts` (the route builder, `bindAll` and the shepherd migration list). `workflows.ts` re-exports them, so importers are unchanged. No behaviour change.
