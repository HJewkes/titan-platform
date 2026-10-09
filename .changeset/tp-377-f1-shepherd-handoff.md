---
"@titan-design/factory": patch
---

Add a Shepherd handoff port for workflow steps. `handoffRef(services)` registers a PR through the `shepherd.register` command, idempotent per repo#pr, and reads a run's status with `landed` or `stopped` and the merge sha from its `sh-landed` or `sh-stopped` step. `FactoryRoutes.bindHost` lets `openFactoryHost` bind the port to the host it opens and unbind it on close; an unbound port throws `handoff not bound`.
