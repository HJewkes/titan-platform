# throughput

**Tier 2.** Depends on [`evidence`](/reference/evidence) for Wilson intervals.

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

### Back-testing the table

`backtest(actuals, { origins, horizonDays, metric, open, config })` checks whether the 80%
interval holds 80%. At each origin it fits `classTable` on rows done and first dispatched
(`firstImplAt`) before the origin, then scores the rows first dispatched in the next
`horizonDays` (default 7). Per class and overall it reports `[p10, p90]` coverage with a
Wilson interval, pinball loss at p10, p50 and p90, the median absolute log error of p50, and
the Spearman correlation of `estimate` against the actual. The same scores are given for
three baselines: the unweighted global quantiles, `estimate` times the global hours per
point, and the unweighted class quantiles. Each class also gets a conformal widening factor
fitted on the previous origin's rows, and coverage is reported both raw and widened.

```ts
import { backtest } from "@titan-design/throughput";

const result = backtest(rowsWithFirstImplAt, {
  origins: ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"],
  open: openTasks, // { taskId, initiative, kind, estimate, firstImplAt } for tasks not yet done
});
result.pooled.coverage.rate; // Wilson interval on the hit rate over every scored row
const week = result.origins[3];
if (week.status === "scored") {
  week.classes["feature/2"]; // model, widenedCoverage, globalMedian, pointsTimesRate, unweightedClass, conformalFactor, open
  week.censored; // open tasks first dispatched in the horizon, per class and as a share
  week.contextLine; // precision and recall at 150k tokens, null when no row carries peakContextTokens
}
```

### Review model and ablation

`reviewTable(actuals, { key, ...config })` predicts the review half of a task once its PR is
up. It covers three targets: `reviewAgentHours` (capped), `reviewRounds` (Shepherd's distinct
heads awaiting a verdict) and `postPrWallHours` (Shepherd's ci, review, re-review, hold and
land minutes over 60; `queued` is left out because it overlaps implementer time). A row with
a null target is skipped and counted for that target only.

With `key: "diff"` rows are keyed `<prClass>/<lead touch>` from the `prClass` and `touches`
that `@titan-design/session-analytics` adds from review-panel's `classifyPr`, for example
`g10/migration` or `standard/none`. A task that merged no PR is keyed `nopr`. A row without
features (a PR missing from the diff cache) is skipped and counted. A key under `minN`
weighted rows backs off to its review class, then global. With `key: "base"` the same code
keys on kind x size band and backs off to the kind. That way the key is the only difference
between the two arms. `reviewFor(table, facts, target)` resolves one task and names the
back-off level.

`reviewAblation(actuals, { origins, horizonDays, config })` compares the two arms on
identical rows. These are the rows that carry PR features. At each origin both arms train on
rows done before it and score rows first dispatched in the next `horizonDays` (default 7). A
row in flight across the origin is in neither set. For each target it reports n, mean
pinball loss at p10, p50 and p90, and `[p10, p90]` coverage with a Wilson interval for each
arm. It also gives `deltaP50` (diff minus base; negative favours the diff key) and flags
`insufficient` under 40 scored rows. Pooled totals cover every origin.

```ts
import { reviewAblation, reviewFor, reviewTable } from "@titan-design/throughput";

const table = reviewTable(rows, { key: "diff" });
reviewFor(table, { prClass: "g10", touches: ["migration", "large"] }, "postPrWallHours");
// { level: "key", levelKey: "g10/migration", n, weightedN, quantiles: { p10, p50, p80, p90 } }

const ablation = reviewAblation(rows, { origins: ["2026-10-05", "2026-10-12"] });
ablation.pooled.reviewAgentHours; // { n, diff, base, deltaP50, insufficient, skippedNull, unscored }
```

### Forecasting a set

`forecastSet(tasks, table, { seed, draws, closure, weekEffect })` answers "how many
agent-hours and dollars is this set of tasks". Each task is resolved with `classFor`, then
each of `draws` (default 2000) simulated sets draws every task's implementer hours, reviewer
hours and USD from its class p10/p50/p80/p90 and sums them. The result gives p10, p50, p80
and p90 of the three totals, and per task the class, back-off level, `n` and closure rate.

Two optional inputs, both fitted on the same rows as the table:

- `closureRates(actuals, table)` is each level's recency-weighted share of rows flagged
  `no-impl-session`. `closureFor(rates, facts)` backs a task off class, kind, size band,
  initiative and global like `classFor`. In a draw a task closes with that probability and
  adds 0 hours and $0.
- `weekEffects(actuals, table)` groups eligible rows by the UTC ISO week of `firstImplAt`
  (or `doneAt`), takes each week's sum of actuals over the sum of class p50s, and normalises
  the ratios to mean 1. Each draw picks one week, and its multiplier applies to every task in
  that draw, so the interval widens for the weeks that go badly together.

```ts
import { classTable, closureRates, forecastSet, weekEffects } from "@titan-design/throughput";

const table = classTable(rows);
const forecast = forecastSet(
  [{ taskId: "TP-1", kind: "feature", estimate: 2 }, { taskId: "TP-2", kind: "docs", estimate: 1 }],
  table,
  { seed: "plan-1", closure: closureRates(rows, table), weekEffect: weekEffects(rows, table) },
);
forecast.totals.implAgentHours; // { p10, p50, p80, p90 } of the set's implementer hours
forecast.tasks; // [{ taskId, kind, band, level, levelKey, n, closureRate, closureLevel }]
forecast.unclassifiable; // tasks whose kind the table has never seen
```

### Back-testing set forecasts

`backtestSets(actuals, { origins, horizonDays, memberships, seed, draws, open, config })`
checks whether a set's 80% interval holds 80%. The caller says which sets each task belongs
to in `memberships`, keyed by `taskId`: a `seat` (the dispatch agent-name prefix), `parents`
and `milestones`. That gives three kinds of group: one per seat and UTC ISO week, one per
parent and one per milestone, each with at least `minSetSize` (default 2) members.

A row starts at `firstImplAt`, or at `doneAt` for a closure. At each origin the table,
`closureRates` and `weekEffects` are refitted on rows done and started before it. A group is
scored at the origin whose horizon (default 7 days) holds its first member's start, and every
member is forecast, even those starting later, because that is what a planner at the origin
would ask. Each group is forecast twice, without and with the week effect, seeded by origin
and group key. Seat-week groups are forecast without closure, because dispatch chose them.
The actual total sums the members, closures counted as 0.

```ts
import { backtestSets } from "@titan-design/throughput";

const result = backtestSets(rows, {
  origins: ["2026-09-07", "2026-09-14", "2026-09-21"],
  memberships: { "TP-1": { seat: "tc", parents: ["TP-2150"] }, "TP-2": { parents: ["TP-2150"], milestones: ["m3"] } },
  seed: "bt-1",
  open: [{ taskId: "TP-3", firstImplAt: "2026-09-15T10:00:00Z" }],
});
result.kinds.parent.independent.implAgentHours; // { hits, n, rate } with a Wilson interval
result.kinds.parent.weekEffect.pinballImpl; // { p10, p50, p90 } pinball loss on implementer hours
result.kinds["seat-week"].censored; // groups holding an open task, counted, not scored
result.groups; // per scored group: kind, key, origin, size, actual and both arms' quantiles
```

## What it deliberately does not do

It reads no database and no task store; the caller passes rows in. It fits no parametric
distribution: a log-normal fit is a later option, allowed only if it wins a back-test. It
does not forecast wall-clock time yet; that lands as `simulateWallClock`. `backtest` measures
a fit without changing it.

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
- `classTable` throws a `RangeError` when no row is eligible, when a `doneAt` or `asOf` does
  not parse, or when `halfLifeDays` is not positive or `minN` is negative. `table.asOf` is
  always an ISO datetime, so `"2026-10-01"` and its full spelling hash the same.
- `backtest` scores only done tasks, so a horizon's slow tasks are missing from it until they
  finish. Pass the not-yet-done tasks as `open`: they are counted per class under `censored`,
  never scored. A high `censored.share` means the coverage of recent origins is optimistic.
- `backtest` skips rows with no `firstImplAt` and counts them in `missingFirstImplAt`. An
  origin with no training rows comes back with `status: "skipped"`. The `clean` stratum
  leaves out rows flagged `weak-link`, `multi-task` or `reopened`.

- `forecastSet` draws each task through linear interpolation between (0, 0) and its four
  quantiles, with an exponential tail above p90 matched to p80 and p90. The tail is unbounded
  on purpose, because a set total is driven by its slowest tasks; a heavier real tail shows
  up as low p90 coverage in a back-test.
- One random draw drives a task's implementer hours and USD together; reviewer hours are
  drawn independently. Tasks are independent apart from the shared week multiplier.
- Without `closure`, no task closes and every `closureRate` is `null`. `closureRates` needs
  the `no-impl-session` rows, so keep them in the rows you pass it. A set chosen by dispatch
  (a seat's week, say) contains no closures, so forecast it without `closure`.
- A task whose kind the table has never seen is listed in `unclassifiable` and still drawn
  at its back-off level, so the totals are not understated. A duplicate `taskId` or a
  non-positive `draws` throws `RangeError`. An empty `weekEffect.weeks` reports
  `weekEffect: "none-available"` and draws as if none were passed.
- Equal tasks, table and options give identical output in any task order. `forecastHash`
  covers the table hash, seed, draws, closure rates and week effect.
- `backtestSets` counts a group holding any `open` task as `censored` and never scores it.
  An open task joins its seat-week group only when it carries `firstImplAt`. Origins with no
  eligible training row come back `skipped`. The week multipliers at an origin are measured
  against the table fitted on the same training weeks, which is mildly optimistic but uses no
  future row.

## Where it came from

New for the TP-2150 throughput model. It replaces planning from the `estimate` field alone
and from hand-computed per-kind tables.
