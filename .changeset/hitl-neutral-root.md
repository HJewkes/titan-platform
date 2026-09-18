---
"@titan-design/hitl": minor
---

Breaking: the root entry no longer exports `SqliteGateStore`, `gateMigration`, or `gateTableDdl` — it is now runtime-neutral (no `node:*` import, no `better-sqlite3`), so it loads in a Cloudflare Workers isolate. `randomUUID` now comes from `globalThis.crypto` instead of `node:crypto`.

Migration: change `import { SqliteGateStore, gateMigration } from "@titan-design/hitl"` to `import { SqliteGateStore, gateMigration } from "@titan-design/hitl/sqlite"`. Everything else (`openGate`, `resolveGate`, `GateStore`, `MemoryGateStore`) is unchanged at the root.
