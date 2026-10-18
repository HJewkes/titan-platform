---
"@titan-design/fix-proof": minor
---

Add an optional `runtime` glob list to `.github/fix-proof.json` (TP-3056 a): matching paths stay carried but read as `source`. Add `testOnlyReading(plan)`, which refuses test-only with `source`, `deletes-tests` or `no-tests`.
