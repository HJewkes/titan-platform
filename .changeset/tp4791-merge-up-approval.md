---
"@titan-design/factory": minor
---

A seat coordinator may now answer `merge` on a land approve-merge gate when the owner answered `merge` on an earlier land gate of the same run, and the head moved since only by clean merge-ups of the base (owner decision 556(3), rule 461). The factory verifies each merge-up itself from a fresh fetch, and refuses with the reason when one is not clean. Which owner answers may follow a head is now one shared predicate (`shepherd/follow-eligibility.ts`) that both the workflow's approval carry and this coordinator path call: the run's kind, route escalations, D21 owner-at-head rows, a FIX_FIRST at the head, and fenced, skill or (for security runs) the PR's own paths on the base side.
