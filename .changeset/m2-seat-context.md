---
"@titan-design/session-analytics": minor
"@titan-design/session-miner": minor
---

Add `seatContext`: per-seat context p50, p90 and max per call over a window, with auto and manual compactions counted from the seat's own sessions. The miner exposes it as `seat-context`, with optional `--p90-max` and `--auto-max` limits that fail the run.
