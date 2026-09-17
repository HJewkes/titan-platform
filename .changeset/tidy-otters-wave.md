---
"@titan-design/session-graph": minor
---

`openSessionGraph` accepts an optional `schemaVersion`: the highest migration version the
caller owns, checked before any migration runs. A product layering its own tables on the
graph passes its own top version, since this package's migrations are one band of a shared
database rather than the top of it.
