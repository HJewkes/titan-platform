---
"@titan-design/fix-proof": minor
---

Add `@titan-design/fix-proof`, the pure core of the fix-proof gate: `planFixProof` (name-status diff and base config to tests, carried files, deleted tests and overlay removals; renames keep their identity), `classifyReports` (base and head vitest JSON to per-test classes and a `reproduced`, `unproven`, `vacuous`, `no-tests` or `error` verdict, matching report files exactly) and `formatResultLine`/`parseResultLine` (a strict `fix-proof/v1` line of at most 4 KB).
