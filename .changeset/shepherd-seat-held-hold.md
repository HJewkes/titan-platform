---
"@titan-design/factory": patch
---

Shepherd waits out a seat reviewer's WAIT over its own MERGE for up to `seatWaitMs` (30 minutes by default). If the WAIT outlasts the bound, the review ends as `external-hold`, with the own MERGE kept as `seatHeld`. It is no longer a `timeout` that spawns a fresh reviewer, and it skips the late read and the correction turn.
