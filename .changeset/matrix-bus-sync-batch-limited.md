---
"@titan-design/matrix-bus": minor
---

Fix the `syncLoop` docstring, which said to persist `since` before handling a batch's
events; that ordering loses events on a crash between persist and handle. The caller
should handle every event first, then persist `since`, deduping by applied event id on
replay.

Add `limited` and `prev_batch` to `SyncBatch`, taken from the joined room's timeline in
the `/sync` response, so `queue-mirror` can detect a gap and backfill after the client
was offline (e.g. a laptop sleep).
