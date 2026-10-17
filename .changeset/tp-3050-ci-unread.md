---
"@titan-design/factory": patch
---

A FIX_FIRST from a reviewer Shepherd dispatched whose only blocking item is the CI-unread line now counts as no verdict (TP-3050). The same head goes to a fresh reviewer, no fixer is woken, and the failed-rounds cap still applies. A new `sh-ci-unread` step records the decision. A run recorded before the step existed replays its FIX_FIRST as it was taken, because its record goes on without the step.
