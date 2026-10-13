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

`forecastSet(tasks, table, { seed, closure, weekEffect })` simulates a set of tasks from
their class quantiles and returns p10/p50/p80/p90 of the set's total hours and USD.
`closureRates` supplies each class's chance of closing with no agent work, and `weekEffects`
a shared per-week multiplier, so tasks done in one bad week move together.

```ts
const closure = closureRates(rows, table);
const weekEffect = weekEffects(rows, table);
forecastSet(tasks, table, { seed: "plan-1", closure, weekEffect }).totals.implAgentHours; // { p10, p50, p80, p90 }
```

`backtestSets(rows, { origins, memberships, seed, open })` checks those set intervals: it
refits at each origin and scores [p10, p90] coverage on seat-week, parent and milestone sets,
with and without the week effect.

`reviewTable(rows, { key: "diff" })` predicts reviewer hours, review rounds and post-PR wall
hours keyed on review-panel class x lead touch, and `reviewAblation` compares that key with
kind x size band on the same rows (pinball loss and 80% coverage per target).

The table carries `modelHash` (config, watermark and package version), `watermark` and
`packageVersion`. Equal inputs give equal output in any row order.

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Reference: https://hjewkes.github.io/titan-platform/reference/throughput
