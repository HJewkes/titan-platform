---
"@titan-design/factory": patch
---

await-new-head: a wait that carries its failing checks and an `inheritedRed` hook re-asks, at most every 5 min, whether the unchanged head's red is the base's, and ends with `baseRed: true` once it is. `LandPrDeps.inheritedRed` passes the hook to land-pr's route. With no hook or no failing checks the wait is unchanged.
