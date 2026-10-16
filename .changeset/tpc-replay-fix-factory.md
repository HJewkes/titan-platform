---
"@titan-design/factory": patch
---

A g10-adversary record from before the two-MERGE ask now replays as it ran instead of parking replay-diverged. The diverged sweep and a superseded restart end a parked run with steps in flight as cancelled at once, so adoption no longer replays it into a loop. `/health` lists `recoveryPrClosed`, and the deploy watch does not count those runs against a build.
