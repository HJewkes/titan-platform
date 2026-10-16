---
"@titan-design/review-panel": minor
---

`reviewerBrief` asks every FIX_FIRST, a first review included, for a `Defect class:` section. A new `earlierFindings` input hands a re-review the run's earlier FIX_FIRST findings with their classes, fenced between `EARLIER-FINDINGS` markers with every verdict-block line removed; the brief then asks for an `Earlier findings:` checklist of `- fixed:` / `- not fixed:` lines (or `Earlier findings: none found`) and for a recurring class's line to be copied exactly. Exports `EarlierFinding`, `EARLIER_FINDINGS_START`, `EARLIER_FINDINGS_END` and `EARLIER_FINDINGS_HEADING`.
