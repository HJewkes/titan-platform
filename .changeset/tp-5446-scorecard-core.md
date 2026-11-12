---
"@titan-design/session-analytics": minor
---

Add the ticket scorecard core (TP-5446 slice S1): `taskRow`, `weekRows`, `rulePick`, `rulePlacement`, `redFlags` with `DEFAULT_THRESHOLDS`, `isoWeek`, and the SQLite store (`SCORECARD_MIGRATIONS`, task and week row upserts and reads, and the write-once weekly pool snapshot). Pure functions over typed rows the caller reads; no I/O beyond the `Db` handed in.
