---
"@titan-design/store-sqlite": minor
---

Record a hash of each migration's declared `definition` in `_migration` and throw `MigrationDriftError` (or warn, with `onDrift: "warn"`) when an applied migration's definition has changed. Rows without a hash are backfilled, never treated as drift.
