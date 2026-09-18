---
"@titan-design/code-graph": minor
---

Add codewatch's rules engine and snapshot diff, ported unchanged: `runChecks`, `validateRules`, `diffSnapshots`, `diffCheckResults`, their rule and result types, and a `checkSnapshot`/`loadCheckRules` entry that checks a snapshot (by id or ref) against a `check.json` with an optional baseline.
