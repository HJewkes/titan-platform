---
"@titan-design/code-read": minor
---

New package: a versioned read API over code-graph snapshots (TP-184). The browser-safe `./query` subpath holds the contract (`CONTRACT`, `CODE_READ_API_VERSION` 0.1.0, zod schemas), `ReadModel` with `buildReadModel`, the `ReadSource` seam, one pure query function per command, and `createQueryResolver` for static datasets. The root adds `loadReadModel`, `createLiveSource` (SQLite with an LRU of three snapshot models), and `registerCodeReadCommands`. First commands: `api.describe` and `snapshot.list`.
