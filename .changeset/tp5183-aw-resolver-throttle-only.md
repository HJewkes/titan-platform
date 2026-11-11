---
"@titan-design/active-work": patch
---

The gh PR resolver no longer re-derives which PRs are due: it takes session-graph's `prsNeedingOutcome`
order and band as given and only applies the failure backoff, the recheck intervals and the per-pass cap.
`ghPrResolver` drops its graph argument.
