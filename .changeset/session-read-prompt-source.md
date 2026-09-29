---
"@titan-design/session-read": minor
---

`Inbound` and the `inbound` audit event carry `promptSource`: the record's own label for who submitted the line (`typed`, `system`, or `sdk` for a headless turn), or null when the record has none. No `WakeCause` value changes.
