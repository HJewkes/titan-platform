---
"@titan-design/factory": minor
---

A seat coordinator may now answer `merge` on a land approve-merge gate when the owner answered `merge` on an earlier land gate of the same run, and the head moved since only by clean merge-ups of the base (owner decision 556(3), rule 461). The factory verifies each merge-up itself from a fresh fetch, and refuses with the reason when one is not clean. Neither the gate nor the approving gate may be a route escalation or hold a D21 owner-at-head row, and no merge-up may bring a carry-fenced or skill path from the base.
