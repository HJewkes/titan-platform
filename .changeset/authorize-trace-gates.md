---
"@titan-design/workflow": patch
---

Each `ctx.authorize` result carries `titan.trace.gates` with one F3 policy gate-decision record per decision, and `TRACE_GATES_KEY` is exported. `policyRule.version` is the table version's semver major; a rule-less deny records row id `no-rule`.
