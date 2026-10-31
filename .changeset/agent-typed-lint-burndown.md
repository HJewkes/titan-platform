---
"@titan-design/agent": patch
---

Clear the typed-lint baseline for most of the package: capability records are built key by key instead of cast, redundant casts and optional calls are gone, and test doubles use `partialFake`. No runtime behaviour change.
