---
"@titan-design/owner-queue": minor
"@titan-design/factory": minor
"titan-console": minor
---

Let the owner approve a g10-held PR now and leave the merge to the adversary loop (TP-4003). A `merge-at-head` op may carry `waitFor: "adversary-loop"`. The factory then records a standing approval on the PR's Shepherd run, pinned to the confirmed head, and answers `approved`. The standing-answer sweep lifts the g10 hold as the owner once Shepherd's g10 release judges the hold met at that head, released or in shadow, and then answers the run's approve-merge at that head. A new head, a FIX_FIRST from the panel or the correctness reviewer, or expiry voids the approval and files a "Merge approval voided" owner inbox item. In the console, a g10-held merge-at-head shows "Merge without both MERGEs" (the forced merge, as before) beside "Approve; merge when the loop closes".
