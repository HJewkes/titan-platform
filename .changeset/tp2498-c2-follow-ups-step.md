---
"@titan-design/factory": patch
---

Shepherd files a reviewer's follow-ups as active-work tasks in a new `sh-follow-ups` step, after the verdict is taken and before it is acted on, for a MERGE or a FIX_FIRST. The step is fail-open: each active-work call is bounded at 10 s, and every filing error is recorded in the step result while the verdict and the step after it stay unchanged. A verdict with no Follow-ups block records no step, and a ledger recorded before this step existed replays without it.
