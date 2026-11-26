---
"@titan-design/authority": minor
"@titan-design/factory": patch
---

Add MRG-AU-RB: automation may merge when the owner left an approve-merge gate unanswered for 24 h at the same head on a merge recommendation, the dispatched reviewer's own MERGE stands at that head and checks are green. New conditions `owner-gate-silent-24h`, `gate-recommends-merge`, `verdict-by-dispatched-reviewer`, `no-hold`, `no-owner-path` and `no-release-path` read the new `MergeFacts` fields `ownerGate`, `verdict.author`, `holdClasses`, `ownerTierPaths` and `headRef`. Any Shepherd hold, a path Shepherd's owner tier holds, an authority, tool-guard, CI, settings, skill or release path, or a release branch never matches. The factory's coordinator check still reads an MRG-AU gate reason that now ends with the MRG-AU-RB unmet list.
