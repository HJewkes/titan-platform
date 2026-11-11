---
"@titan-design/active-work": patch
---

The test-support `runCli` helper returns empty strings, not null, for stdout and stderr when the child fails to spawn (TP-5220). Test support only; no production code changes.
