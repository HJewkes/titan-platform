---
"@titan-design/workflow": patch
---

Map every character outside letters, digits and underscore in a step id to `_` when building `STEP_OUTPUT_` variables, so fan-out (`review/src/a.ts`) and suffixed (`ci-wait:final`) step outputs are reachable from a template. Ids that collide after mapping share one variable; the later result wins.
