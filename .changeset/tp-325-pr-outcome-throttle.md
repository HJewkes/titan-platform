---
"@titan-design/active-work": patch
---

The gh-backed PR outcome poll no longer asks about a PR again before its recheck interval has passed: 10 minutes for an open PR (`AW_PR_OPEN_RECHECK_MS`) and 24 hours for a closed one (`AW_PR_CLOSED_RECHECK_MS`). A closed PR is now re-checked after that interval, so a reopen on GitHub is seen. The last-checked time is the `pr.outcome_checked_at` column, so the throttle holds across daemon passes.
