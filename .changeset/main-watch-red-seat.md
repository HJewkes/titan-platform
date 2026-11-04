---
"@titan-design/factory": patch
---

New config key `shepherd.redSeat` (`{ repos?: { "owner/name": seat }, fallback?: seat }`): the main CI watch sends a repo's red-main events to its entry (keys match in any case), else to `fallback`, ahead of the run's seat, the branch-prefix seat and `shepherd.hubSeat`. Only red events read it; merge policy and the seat a run records still come from the seat file. The dead-seat alarm checks the red seat in their place.
