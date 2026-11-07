---
"@titan-design/factory": patch
---

`ShepherdDeps.gitCache` carries the git cache ports to the carry, review, g10-rehold and stack-land route builders, which pass `{ ports: deps.gitCache, ...wiring?.carry }` down. `workflows.ts` sets it to `hostCarryPorts`, so behaviour is unchanged. `ReviewWiring.carry` no longer accepts `ports`.
