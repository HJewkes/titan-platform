---
"@titan-design/store-sqlite": minor
---

Add an opt-in forward-schema guard. `openDatabase(path, { schemaVersion })` and
`assertSchemaVersion(db, knownVersion)` throw `SchemaTooNewError`, naming both versions,
when a database is stamped past the highest migration the runtime knows, instead of
proceeding into a schema that has already moved on.
