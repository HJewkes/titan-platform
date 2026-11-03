---
"@titan-design/factory": patch
---

TP-3106 S2: the step registry now has an entry for every step the factory workflows declare, one file per family under `src/registry/steps/`. A restart drops a step's orphan exactly when its registry entry's effect class is `read`; the `orphanSafe` flag on step declarations is gone, and the restart contract's list of parking steps is derived from the registry. No step's restart outcome changes. The 34 read steps not yet reviewed carry a temporary `pending` effect, which parks as before.
