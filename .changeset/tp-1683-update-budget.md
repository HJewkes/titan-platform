---
"@titan-design/factory": patch
---

`land` stops chasing a moving base where the ruleset does not require it. In a repo without strict required checks, a green head whose base moved after its CI started now reads `behind` with `checksGreen` and `baseMoved`, so Shepherd reviews it first; `land` takes it to the merge decision as is and refreshes it with one update-branch only after the merge is approved, then merges even if the base moved again. In a strict repo, a behind head is updated only once its required checks have settled, so a base move costs one CI run per PR rather than one per move, and the `stuck-behind` gate now opens after at least `MAX_UPDATE_CYCLES` (3) updates and `UPDATE_BUDGET_MS` (120 minutes) since the first update of the bound, timed from the `at` that `update-branch` and the `readAt` that `ci-wait` now record. A recorded run without those times keeps the fixed count of 3. The gate text names the elapsed time and the budget beside the heads.
