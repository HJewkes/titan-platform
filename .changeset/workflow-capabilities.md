---
"@titan-design/workflow": minor
"@titan-design/factory": patch
---

Capability context: `WorkflowRuntimeOptions.capabilities` and `ctx.capability(name)` give step bodies an opaque handle whose declared secrets are refused (`CapabilityLeakError`) or redacted before they reach step output, the trace, the store or a prompt variable. The factory's guarded context forwards `capability`.
