---
"@titan-design/session-read": minor
"@titan-design/factory": patch
---

Read `Verdict: WAIT` (required checks unfinished at the reviewed head) as no verdict, never a MERGE. `parseVerdictBlock` returns `{ ok: false, reason: "wait" }` with the PR and head the block names; Shepherd's `acceptVerdict` returns `none` with reason `wait`, and a seat reviewer's WAIT at a head never reads clear for a carry or a MERGE.
