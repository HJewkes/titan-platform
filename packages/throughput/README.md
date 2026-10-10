# @titan-design/throughput

Per-class throughput model: recency-weighted quantiles of agent-hours and cost over task
actuals.

`classTable(actuals, config)` returns p10, p50, p80 and p90 of `implAgentHours`,
`reviewAgentHours` and `usd`, keyed kind x size band (estimate `<=1`, `2`, `3`, `>=4`,
`none`). Rows are weighted by a 21-day recency half-life. A class below 20 weighted rows
backs off to its kind, its size band, the task's initiative, then global, and names the
level and n it used. `classFor(table, { kind, estimate, initiative })` resolves one task.

```ts
import { classFor, classTable } from "@titan-design/throughput";

const table = classTable(rows, { minerIndexedAt });
classFor(table, { kind: "security", estimate: 2, initiative: "web" });
// { level: "kind", levelKey: "security", n: 31, weightedN: 22.4, implAgentHours: { p10, p50, p80, p90 }, ... }
```

The table carries `modelHash` (config, watermark and package version), `watermark` and
`packageVersion`. Equal inputs give equal output in any row order.

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Reference: https://hjewkes.github.io/titan-platform/reference/throughput
