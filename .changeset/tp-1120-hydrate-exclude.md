---
"@titan-design/workflow": patch
"@titan-design/factory": patch
---

`WorkflowRuntime.hydrate` takes an optional `exclude` set of run ids to leave unclaimed. Factory serve uses it so a held Shepherd run whose PR read fails is no longer adopted and driven: it waits for the next tick, when a successful read ends it or adopts it.
