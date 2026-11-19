---
"@titan-design/factory": minor
---

`shepherd freeze` and an `unfreeze` that lifted a freeze now append `repo-freeze` and `repo-unfreeze` rows to the Shepherd timeline, with no run, the repo, the actor and the reason. The kinds arrive in migration 55; the freeze and thaw kinds and the SLO freeze-hours pairing are unchanged. `shepherd unfreeze` now records the caller as actor.
