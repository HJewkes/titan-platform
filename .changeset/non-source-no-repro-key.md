---
"@titan-design/review-panel": patch
"@titan-design/coordinator": patch
"@titan-design/factory": patch
---

Add `shepherd.gateReset.nonSourceNoRepro` (`keep-owner` when absent, today's behaviour). With `record-fact`, a fix-proof NO_REPRO on a non-security PR whose every changed path is tests, workflows, changesets or docs goes to review marked unverified `no-repro-non-source`, and no `sh-sent-back` owner gate opens; the merge grant is unchanged. The row is live-editable, and the reviewer brief names the new standing (TP-4275).
