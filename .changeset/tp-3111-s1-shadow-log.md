---
"@titan-design/factory": patch
---

TP-3111 S1: the SHD-2 disagreement log. Migration 50 adds `factory_shadow_log`, append-only like the marker table, with a partial unique index that keeps a call-site orphan to one row per (run, marker) across restarts. `logSink(db, now)` persists every shadow event kind as one row, with full and material validity on verdict rows, and `readLog` reads a window back for the report. Nothing wires the sink yet; the blob stays authoritative.
