---
"@titan-design/workflow": minor
---

`ctx.capability(name)` now works only inside a step body (a seed's function). Asked from the workflow function between steps, it throws the new `CapabilityOutsideStepError`, which names the capability and never its handle or a secret. The scope is an `AsyncLocalStorage` entered around the seed's function, so two seeds running at once under `Promise.all` each get the handle while the workflow body between them does not. A workflow that read a capability outside a seed must move that call into one.
