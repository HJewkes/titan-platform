---
"@titan-design/authority": minor
"@titan-design/factory": patch
---

Add MRG-AU-RB: automation may merge when the owner left an approve-merge gate unanswered for 24 h at the same head on a merge recommendation, the MERGE at that head came from the reviewer Shepherd dispatched and checks are green. The row keeps every MRG-AU-RV condition but the seat grant. New conditions `owner-gate-silent-24h`, `gate-recommends-merge`, `no-g10-hold` and `no-release-path` read the new `MergeFacts` fields `ownerGate`, `holdClasses` and `headRef`. A g10 hold, an authority, tool-guard, CI, skill or release path, or a release branch never matches. The factory's coordinator check still reads an MRG-AU gate reason that now ends with the MRG-AU-RB unmet list.
