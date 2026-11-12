---
"@titan-design/factory": patch
---

`shepherd.mergeWake` runs a configured argv once per settle window (default 20 s, at most 30 s) after Shepherd records a merge, so the burndown tick starts without waiting for its 10-minute timer (TP-1433). Absent, nothing changes.
