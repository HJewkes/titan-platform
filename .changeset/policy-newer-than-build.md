---
"@titan-design/factory": patch
---

A stored policy, a registration row or a run param, that carries a key this build lacks now fails as a named `PolicyNewerThanBuild` error. It names the key and says to deploy current main, instead of a raw zod `unrecognized_keys` throw from a CLI older than the store.
