---
"@titan-design/factory": patch
---

Shepherd's 5-minute gone sweep clears a `main-ci-timeout` gate once the base branch's tip contains the merge sha and is green on every required context, recording that evidence on the run. The gate stays open while main is red, still running or off the merge's line (TP-4319).
