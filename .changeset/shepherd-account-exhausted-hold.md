---
"@titan-design/factory": minor
---

Hold a Shepherd run as account-exhausted when its reviewer hits the account's usage limit, instead of re-spawning reviewers and falling to approve-merge. The run waits inside the review under the store hold (`account-exhausted: <configDir> until <reset>; TP-1955`), the repo's seat gets one alert per exhaustion of an account, no reviewer is spawned on an exhausted account until its reset or an owner release, and the review is run again at the PR's current head when the hold lifts. The new optional `shepherd.review.fallbackConfigDirs` list moves the review to the next account with headroom.
