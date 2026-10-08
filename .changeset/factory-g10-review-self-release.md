---
"@titan-design/factory": minor
---

Release a `g10-review` hold without a seat command when the run's own opus reviewer (`shepherd.review.profile`) has sent MERGE at the PR's current head, read fresh, and the required checks are green there. The `sh-g10-release` step records the verdict ref. `g10-adversary` and every other hold class still need `shepherd release`.
