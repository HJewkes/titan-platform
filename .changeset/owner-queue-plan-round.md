---
"@titan-design/owner-queue": minor
---

Add `buildPlanRound` (TP-4360): it turns one PR's predicted merge gates (ci-policy, skill, visual) into a questions-only round@2 round.json with a `planApprovals` block, which `titan-console decisions file -` takes as is. The owner's approve pick records each ask's task, repo, gate and scope as a plan approval.
