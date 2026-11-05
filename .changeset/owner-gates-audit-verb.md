---
"@titan-design/factory": minor
---

Add `titan-factory owner-gates audit` and `owner-gates weekly`. `audit` samples 5 owner-resolved gates from one ISO week, seeded by the week, and reads each gate's 72 h outcome. Incidents come from the deployer's `deploy-incidents.jsonl` in the factory state dir, linked to the merge through ancestry in the deploy checkout. If the log or ancestry is unreadable, the item reads `incidents unknown`. Each gate gets a sonnet judge note; if the judge fails, the file is still written and the item reads `judge unavailable`. The verb writes `<active root>/titan-platform/sources/owner-gate-audit-<YYYY-Www>.md`. `weekly` audits the previous week, then runs `report --deposit` with that audit consulted. The Monday timer units are `ops/systemd/titan-owner-gates.{service,timer}`.
