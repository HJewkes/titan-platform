---
"@titan-design/explainer": minor
---

A repo run now writes a companion doc. `renderCompanion` renders `companion.md` from the gathered review facts: one section per repo-tour block, anchored by the block id, and an anchor per fact. `companionChapters` maps each script chapter to the blocks its spine rows play, and a chapter that merges tour blocks links the first one, so the tour and its review-digest cut link into the same doc. The script stage writes `companion` and `chapter-links` (`explainer.chapter-links/v1`) when its facts are gathered review facts; other runs are unchanged. A review with no SUMMARY facts warns `W-NO-SUMMARY`. The script stage version changes to `x5`.
