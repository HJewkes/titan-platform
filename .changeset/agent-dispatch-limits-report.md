---
"@titan-design/agent-dispatch": minor
---

Add `limitsReport` and `limitsReportSchema` to `./limits`: a pure projection of a planner's dry-run result, the claim ledger and a Shepherd read onto the v1 `/limits` report (binding, roles live against the ledger, pools, refusals with top PR blockers, supply with bookkeeping under `seeded`, worktrees, Shepherd reviews in flight, contradictions). The input is the structural `LimitsPlanInput`; the report reads no config.
