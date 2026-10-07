---
"@titan-design/session-analytics": minor
---

`parseVerdict` now reads verdicts with session-read's `parseVerdictBlock` and matches heads exactly, so a short or prefix head no longer counts. `blockedFlowReport` gains `refusedVerdicts` (and an optional `unparsedVerdicts` input) for verdicts the merge gate would refuse; they stay out of `verdictToMerge` and `openHoldingMerge`.
