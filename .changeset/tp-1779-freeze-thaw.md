---
"@titan-design/factory": patch
---

Merge policy's freeze read and `shepherd resync` now re-read the default branch through the freeze guard's green-after-red recheck, sharing its five-minute per-repo limit, so a main fixed outside Shepherd thaws a stale freeze without an owner gate. A failed read leaves the repo frozen.
