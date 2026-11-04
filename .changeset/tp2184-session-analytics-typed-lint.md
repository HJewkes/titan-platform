---
"@titan-design/session-analytics": patch
---

Typed-lint burn-down: the SQL readers type their rows through `prepare<Params, Row>` and the JSON key and record reads narrow instead of asserting. A tool-result array with a null element no longer throws in the denial classifier. No other behaviour change.
