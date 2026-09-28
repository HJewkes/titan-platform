---
"@titan-design/workflow": minor
---

Add `routedRunner(routes)`: one runner that sends each dispatch step to the runner its route names, with a per-route restart rule. `repeat` redispatches a step interrupted by a crash; `park` leaves the run `recovery_required`. `assertRoutes(workflowName, stepIds)` fails registration on an unrouted step id, and two routes with the same match fail at construction.
