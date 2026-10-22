---
"@titan-design/factory": patch
---

`/health` gains `deployPaused: {paused, since, reason, lastRollback}`, read from `deploy-pause.json`, so a seat can see a deploy pause without running `service pause`. A missing file reads as not paused; an unreadable one reads as `paused: null` with a reason.
