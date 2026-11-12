---
"@titan-design/active-work": patch
---

Test-only: the cli, daemon, document-frequency and setup-steps tests parse JSON through zod and build fakes through type guards instead of type assertions, and their TP-3538 suppression entries are cleared. No production code changes.
