---
"@titan-design/review-panel": patch
---

Add `changedLineCount` and a `generated` glob list to `ClassRules`: generated registry files (CAPABILITIES.md, site reference pages, the reference sidebar, the capabilities guide, `.codewatch/check.json`) no longer count toward a large PR, unless they alone pass `largeLines` or a rename moved the file in from a written path. `ChangedFile` gains `previousPath` and `ReviewerFacts` gains `sizeUnread`.
