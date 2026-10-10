---
"@titan-design/factory": minor
---

Hold a Shepherd run as account-exhausted when its reviewer hits the account's usage limit, instead of re-spawning reviewers and falling to approve-merge. Only Claude Code's own `<synthetic>` limit record counts, never a reviewer's words. The run waits inside the review under the store hold (`account-exhausted: <configDir> until <reset>; TP-1955`), which is matched exactly so an owner's hold is never touched. The repo's seat gets one alert per exhaustion of an account. No reviewer is spawned on an exhausted account until its reset (believed only within 8 days, else re-checked after an hour) or an owner release, and the review runs again at the PR's current head when the hold lifts. The new optional `shepherd.review.fallbackConfigDirs` list moves the review to the next account with headroom. The restart drain does not wait on a held run.
