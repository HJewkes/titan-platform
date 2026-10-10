---
"@titan-design/factory": patch
---

Shepherd now supersedes a pending `shepherd-route` `fix-first-runaway`, `no-progress` or `conflict` approve-merge gate when the pull request head moves past the gated head, in the serve sweep and in resync. The new head is reviewed, and the owner is asked again there with the gate naming the carried reason and the new review; the superseded gate is cancelled, never answered, so even an `auto` policy does not merge the new head on its own.
