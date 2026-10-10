# throughput

**Tier 2.** No titan dependencies yet.

```sh
npm install @titan-design/throughput
```

## The problem it solves

Planning a set of tasks needs an honest answer to "how long does a task like this take".
The `estimate` field on a task is a guess in points, and one average over every done task
hides the spread between a docs fix and a security change. A per-class table needs care:
small classes give noisy quantiles, old rows describe practice that has since changed, and
a table that changes between two identical runs cannot be cited.

The primitive is `classTable(actuals, config)`. It takes one row per done task and returns
weighted empirical quantiles (p10, p50, p80, p90) of implementer agent-hours, reviewer
agent-hours and USD, keyed kind x size band. Each row is weighted by recency with a 21-day
half-life. A class with fewer than 20 weighted rows backs off to its kind, then its size
band, then the task's initiative, then everything, and the entry names the level and the n
it used. `classFor(table, facts)` resolves one task's class the same way.

The table carries a model hash of its config, the snapshot watermark and the package
version. The same rows and config always give the same table, whatever the row order.

## When to reach for it

Turning task actuals into per-class figures a planner, a coordinator ETA or a report can
cite. The input rows are structural: a `taskActuals` row from
[session-analytics](./session-analytics.md), spread with the task's `kind` and `estimate`,
fits as is. Producing the actuals themselves (priced sessions, idle caps, role split)
belongs to session-analytics. For intervals on pass rates, use the `./stats` subpath of
[evidence](./evidence.md).

## Example

Verified against 0.0.0.

```ts
import { classFor, classTable } from "@titan-design/throughput";

const rows = Array.from({ length: 24 }, (_, i) => ({
  taskId: `T-${i}`,
  initiative: "web",
  doneAt: "2026-09-30",
  implAgentHours: { capped: (i + 1) / 4 },
  reviewAgentHours: { capped: 0.5 },
  usd: i + 1,
  kind: i < 20 ? "feature" : "docs",
  estimate: 2,
}));

const table = classTable(rows);
table.classes["feature/2"]; // level "class", n 20, implAgentHours { p10: 0.5, p50: 2.5, p80: 4, p90: 4.5 }
classFor(table, { kind: "docs", estimate: 2, initiative: "web" }); // level "band", levelKey "2", n 24

const stale = classTable(rows.map((row) => ({ ...row, doneAt: "2026-09-09" })), { asOf: "2026-09-30" });
stale.classes["feature/2"]; // level "global": 20 rows 21 days old weigh 10, below the minimum of 20
```

## What it deliberately does not do

It reads no database and no task store; the caller passes rows in. It fits no parametric
distribution: a log-normal fit is a later option, allowed only if it wins a back-test. It
does not forecast a set of tasks or wall-clock time yet. Those land as `forecastSet` and
`simulateWallClock` in later releases.

## Gotchas

- `n` counts rows and `weightedN` sums their recency weights. The back-off threshold
  applies to `weightedN`, so a class of 25 rows from three months ago backs off.
- Recency counts back from `config.asOf`, which defaults to the newest `doneAt`, not to
  the clock. Pass `asOf` to fix it; the result never depends on when it runs.
- `table.classes` covers every observed kind x size band, backed off without an initiative,
  because a class spans initiatives. Use `classFor` with the task's initiative to get the
  initiative step.
- Rows flagged `no-impl-session` are left out of the quantiles and counted in
  `excludedRows`. A missing `kind` becomes `untagged`; a missing `estimate` is band `none`.
- The model hash covers the config, the watermark (newest `doneAt` and the optional
  `minerIndexedAt`) and the package version, not every row. Pass `minerIndexedAt` so a
  re-index with no new done task still changes the hash.
- `classTable` throws a `RangeError` when no row is eligible or a `doneAt` does not parse.

## Where it came from

New for the TP-2150 throughput model. It replaces planning from the `estimate` field alone
and from hand-computed per-kind tables.
