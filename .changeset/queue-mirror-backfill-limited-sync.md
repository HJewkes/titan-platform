---
"@titan-design/queue-mirror": patch
---

Follow `prev_batch` backwards when a sync batch is `limited`, so events dropped in a gappy sync are applied oldest-first before the batch. Paging stops at the first already-applied event, the end of history or 10 pages, and logs a `backfill gap` warning when the cap is hit.
