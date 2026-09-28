---
"@titan-design/session-read": patch
---

session-read: a `cost-state` line carries no timestamp of its own; `LineReader` now stamps it (and any other timestamp-less line) with the last preceding line's timestamp instead of an empty string (TP-346).
