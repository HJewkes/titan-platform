---
"@titan-design/factory": patch
---

Shepherd reviews a PR that is behind its base as soon as its own required checks are green, and brings the branch up to date only on the way to the merge, where each clean base merge carries the reviewed MERGE. The `stuck-behind` gate and outcome now name the update count and every head the updates started from.
