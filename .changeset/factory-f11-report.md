---
"@titan-design/factory": patch
---

Adds the F11 report (TP-3103 F6). `event-log/f11-window.ts` reads the event-log rows observed in `[since, until)` over a read-only connection, and `event-log/f11-report.ts` turns them, the serve log and the HJewkes rate sample into one report: the kind census (polling clock) or agreement (webhook clock), disagree-class and `head-regression` counts, distinct check run ids per (sha, check), and each identity's peak against 50% of its limit. `pnpm --filter @titan-design/factory f11` runs it offline and writes JSON plus a markdown section; nothing runs in serve.
