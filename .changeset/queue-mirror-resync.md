---
"@titan-design/queue-mirror": minor
---

Add a `resync` SourceEvent that re-runs open() reconciliation and commits its cursor, and edit a phone item `refused: <detail>` when the source rejects a verdict, leaving it open. Document that `QueueSource.tail` must connect eagerly.
