---
"@titan-design/factory": minor
---

`shepherd.repos.<repo>.statusContexts` names commit-status contexts that count as the repo's CI beside its Actions check runs. Land's ci-wait, its open-repo rule and `sh-main-ci` read each as a check run: success is green, pending or not yet posted holds, failure or error is red. Repos without the key read as before (TP-4645).
