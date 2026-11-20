---
"@titan-design/factory": patch
---

Shepherd records a reviewer's Check-candidates in a new `sh-check-candidates` step, after `sh-follow-ups`, for a MERGE or a FIX_FIRST and for each panel member. Each candidate becomes one `check_candidates` row with the member (panel shape, reviewer agent id and its own verdict) and the PR's area: the `packages/<x>` or `products/<x>` dir, else the first path segment, with the most changed lines. The step never throws and never changes the verdict; it reads `shepherd.checkCandidates` in its body, so `off` records `skipped: "off"` and writes nothing. A verdict with no block records no step, and a ledger recorded before the step existed replays without it.
