---
"@titan-design/session-read": minor
"@titan-design/factory": minor
---

`parseVerdictBlock` reads an optional `Closer: yes|no` line directly after Head on a FIX_FIRST block and returns it as `closer`; absent, on MERGE, malformed, duplicated or misplaced it stays undefined and the block parses as before. Shepherd carries `closer` on a FIX_FIRST verdict and opens approve-merge with the new `no-progress` escalation at the second consecutive FIX_FIRST that said `Closer: no`, before the `fix-first-runaway` cap. Any other round resets the streak.
