---
"@titan-design/factory": patch
---

Add the A17 runner (TP-3825): `pnpm --filter @titan-design/factory a17 --out <path>` runs every A17 case and writes an `a17-report/v1` report, exiting non-zero when a case lacks a mode sibling or either mode did not pass.
