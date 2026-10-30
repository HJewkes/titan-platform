---
"@titan-design/factory": patch
---

The service deploy drain no longer waits on runs parked in `sh-order-wait`. They only poll for the PRs merging ahead of them and replay that wait under the new build, so counting them as busy stretched a deploy past 30 minutes (TP-4567).
