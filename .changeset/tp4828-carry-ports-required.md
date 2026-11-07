---
"@titan-design/factory": patch
---

tree-carry's `CarryOptions.ports`, `StackLandDeps.ports` and `LandPrDeps.gitCache` are now required, and the `hostCarryPorts` fallback and the `CarryOptions.git` and `StackLandDeps.git` overrides are gone, so tree-carry imports no adapter and leaves the recipe capability baseline (TP-4828). Behaviour is unchanged: production already passes the host's ports.
