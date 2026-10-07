---
"@titan-design/store-sqlite": minor
---

`WatermarkTable.advance`, `rewind` and `markStatus` now return `boolean`: `true` when a row matched, `false` (with nothing written) for a source key that was never `ensure`d. They still do not throw. The docs now describe the entity table as current state with soft expiry rather than interval bi-temporal, and document `SpanFtsTables.search`'s `scope` argument and `SpanScope`.
