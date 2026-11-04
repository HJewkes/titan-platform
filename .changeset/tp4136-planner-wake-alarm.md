---
"@titan-design/factory": patch
---

`planner wake` now waits for the planner's review: it polls the new `reviewDir` until a `*.md` newer than the spawn appears, and files an owner-inbox alarm (with the transcript's last API error) when the planner exits without one or after `noFileAfterMinutes` (default 30), exiting 1. The next wake that sees a review withdraws the alarm. A `configDir` under `.claude-profiles/personal` is refused.
