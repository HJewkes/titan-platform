---
"@titan-design/review-panel": patch
"@titan-design/coordinator": patch
"@titan-design/factory": patch
---

Add `shepherd.gateReset.nonSourceNoRepro` (`keep-owner` when absent, today's behaviour). With `record-fact`, a fix-proof NO_REPRO on a non-security PR that changes no source goes to review marked unverified `no-repro-non-source`, and no `sh-sent-back` owner gate opens; the merge grant is unchanged. No source means the fix-proof plan, under the trusted configs, sorts no path as source, or the diff is the workflow-only diff a CI proof read. `@titan-design/review-panel` exports `noReproProceedOf`, the one reading of which unverified standings proceed and on what, so the brief rule, the tests member question and the panel plan all follow it. The row is live-editable (TP-4275).
