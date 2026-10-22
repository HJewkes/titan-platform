---
"@titan-design/factory": patch
---

The reconciler has one cadence knob: `github.backstopIntervalMs` under webhook and `github.pollingIntervalMs` under polling. `reconciler.intervalMs`, which nothing read, is deprecated: the load still accepts any number there for one release, so a config that sets it keeps starting, and serve logs `config.deprecated reconciler.intervalMs ignored; use github.backstopIntervalMs` at start. The cross-field check that bounded it to 5-10 minutes under `github.sources: webhook` is gone, since `github.backstopIntervalMs` already carries that bound.
