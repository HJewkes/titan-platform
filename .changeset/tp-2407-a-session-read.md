---
"@titan-design/session-read": minor
---

`parseVerdictBlock` reads an optional `CI-policy: unchanged | weakened <keys>` line directly after `Head:` on a MERGE block and returns it as `ciPolicy`. Keys come from the closed set `CI_POLICY_KEYS`; a malformed, duplicated, misplaced, fenced or quoted line reads as missing.
