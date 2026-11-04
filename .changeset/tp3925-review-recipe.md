---
"@titan-design/review-workflow": minor
---

Add `reviewHead`, the recipe that reviews one full PR head over recorded steps (preflight, one heal pass, the plan, the member fan-out with each member's retry-policy row, the aggregate and a typed outcome), `REVIEW_STEP_BODIES`, its step bodies, and `classifyFailure`. A member with a verdict is never dispatched again, and the same refusal twice goes to the fixer at once. `ReviewHeadInput` gains a required `runId`, and `heal-ineffective` joins the failure classes with its own fixer row (TP-3925).
