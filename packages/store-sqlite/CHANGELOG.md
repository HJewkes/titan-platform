# @titan-design/store-sqlite

## 0.1.0

### Minor Changes

- aa5f694: Build the store kit: `openDatabase`, a transactional `_migration` runner, the `<kind>:<id>`
  ref grammar, and composable table factories with prepared helpers for interval bi-temporal
  edges and entities, snapshot-scoped entities, content-addressed cache blobs, contentless
  FTS5 spans, and per-source watermarks. `kitMigration` installs a selection as version 1.
