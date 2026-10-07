---
"@titan-design/factory": patch
"@titan-design/workflow": minor
---

A Shepherd run replayed after a serve restart now follows the route its record took after each review, so a route table changed by a redeploy no longer sends it back to review or publish at a head it already left. Resync answers an active reviewer-starting step whose head the PR has moved past, and supersedes nothing when the PR cannot be read (TP-1831). The workflow context gains `historyNext()`, and the runtime gains `completeStep()` for a run no runtime holds.
