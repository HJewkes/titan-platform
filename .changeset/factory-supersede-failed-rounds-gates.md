---
"@titan-design/factory": patch
---

Shepherd now supersedes a pending `shepherd-route/failed-rounds` approve-merge gate when the pull request head moves past the gated head, so resync, `resync --dry-run` and the serve sweep return the run to CI and review at the new head, whose failed review rounds count from zero. A route gate for any other reason, such as a conflict or no progress, stays with the owner.
