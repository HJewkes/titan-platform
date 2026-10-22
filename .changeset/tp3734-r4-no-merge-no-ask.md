---
"@titan-design/factory": patch
---

Shepherd no longer asks the owner to merge a head with no reviewer MERGE (TP-3734 r4). Such an approve-merge gate does not open: the head gets one fresh reviewer (`R4/fresh-reviewer`), then the repo's seat hears and the run waits for a new head; the gate opens only when that notice cannot go out, saying why. D7 and D8 route escalations keep their own paths. The approve-merge brief no longer claims no reviewer said MERGE when a panel member did. `GATE_DEMOTIONS.noMergeNoAsk` reverts it.
