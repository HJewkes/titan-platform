---
"@titan-design/factory": minor
---

A Shepherd reviewer that exits, deregisters or stays detached without a verdict ends `sh-await-verdict` after a grace (`exitGraceMs`, default 1 min; `detachGraceMs`, default 10 min, so a broker restart does not count) instead of waiting out the 30-minute timeout. The review phase then dispatches one fresh reviewer at the same head, never resuming the one that went silent. Only a second silence returns `none`. The approve-merge gate it reaches says `no reviewer verdict` and why, under rule `shepherd-review/no-verdict`, in place of the seat or authority text.
