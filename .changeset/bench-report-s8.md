---
"@titan-design/evals": patch
---

Add the bench report: per-track arm tables over complete blocks only (Wilson CIs, R by case type, I solved, P win rate against the anchor), paired bootstrap and exact McNemar comparisons against O-med with Holm and MDEs, cost per success with a case-resampling CI, the routing table with its "too thin, keep production" rule, two cost ledgers, and `report.json` plus a `REPORT.md` skeleton. The `bench report` verb lives in `cli-report.ts` (`registerReport`).
