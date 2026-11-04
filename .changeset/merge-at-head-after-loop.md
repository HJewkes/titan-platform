---
"@titan-design/owner-queue": minor
"@titan-design/factory": minor
"titan-console": minor
---

Let the owner approve a g10-held PR now and leave the merge to the adversary loop (TP-4003). A `merge-at-head` op may carry `waitFor: "adversary-loop"`. The factory then records a standing approval on the PR's Shepherd run, pinned to the confirmed head and to the g10 hold class the owner saw, and answers `approved`. The standing-answer sweep lifts the g10 hold as the owner once a g10 release Shepherd writes after the tap judges that hold met at that head, released or in shadow: the two-MERGE rule for `g10-adversary`, the single-MERGE release for `g10-review`. It then answers the run's approve-merge at that head. A new head, a hold escalated to another g10 class, a FIX_FIRST from the panel or the correctness reviewer, or expiry voids the approval and files a "Merge approval voided" owner inbox item. In the console, a g10-held merge-at-head shows "Merge without both MERGEs" (the forced merge, as before) beside "Approve; merge when the loop closes".
