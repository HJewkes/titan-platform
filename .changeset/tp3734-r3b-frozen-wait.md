---
"@titan-design/factory": patch
---

Shepherd no longer opens approve-merge when MRG-AU-RV fails on `repo-not-frozen` alone: land waits at the head, re-reading the merge facts, and merges after the thaw with no gate or notice. A `no-facts` merge-guard gate re-reads once at the head, then sends the seat one notice (the owner gate opens only when no notice could be sent). Both sit behind `WAIT_DEMOTIONS` in `freeze-wait.ts` (TP-3734 r3b).
