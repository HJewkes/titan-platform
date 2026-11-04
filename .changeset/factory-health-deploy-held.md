---
"@titan-design/factory": patch
---

`/health` gains `deployHeld: {held, since, reason, source}`, read from `deploy-hold.json` through the same reader the deployer uses, so a manual or Morning deploy hold shows beside `deployPaused`. A missing file reads as not held; an unreadable one reads as `held: null` with a reason.
