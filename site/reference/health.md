# health

**Tier 1.** Depends on [store-sqlite](./store-sqlite.md); `zod` is a peer dependency.

```sh
npm install @titan-design/health zod
```

## The problem it solves

Every daemon answers `/health` with its own shape: some send `{ ok: true }`, some add a
pid, a port and product keys such as `runs` or `build`. A monitor reading them has to
guess what "up" means for each one, and a payload with a degraded check still says `ok`.

This package adds one contract, health/v1, after the open IETF draft
draft-inadarei-api-health-check: a `status` of `pass`, `warn` or `fail`, the `checks` behind
it (keyed `component:measurement`, each an array with one entry per node or instance, as in
the draft), `started_at` and `metrics`. The legacy fields (`ok`, `version`, `pid`,
`uptime_ms`, `port`) stay, so old readers keep working. It also defines the sample row a
health probe stores.

## When to reach for it

- A product builds its health payload: validate it with `healthReportSchema` before it
  leaves the process.
- A monitor or probe reads someone else's health payload: use `parseHealthReport`, which
  accepts legacy payloads and newer ones it does not fully know.
- A probe stores its results: append each tick's rows with `appendSamples`.
- A report asks how long a target was up: `uptime` over the store, or `foldUptime` over
  samples you already hold.

Neighbours: serving the health route, with its pid file, is [daemon](./daemon.md); the SQLite
primitives under the sample store are [store-sqlite](./store-sqlite.md).

## Example

Verified against 0.0.0.

```ts
import { healthReportSchema, healthSampleSchema, parseHealthReport } from "@titan-design/health";

const report = healthReportSchema.parse({
  status: "warn",
  checks: {
    "deploy:state": [{ status: "warn", observedValue: "rolled-back", output: "build failed" }],
    "github:reachable": [{ status: "pass" }],
  },
  started_at: "2026-01-01T00:00:00Z",
  ok: true,
  pid: 4242,
  port: 7410,
});

parseHealthReport({ ok: true, pid: 4242, version: 2 });
// { ok: true, report: { status: "pass", ok: true, pid: 4242 }, ignored: ["version"] }

healthSampleSchema.parse({ ts: "2026-01-01T00:01:00Z", target: "factory", kind: "http", status: "pass", latencyMs: 12 });
// source defaults to "probe"
```

## Write strict, read loose

| | Write (`healthReportSchema`, `healthSampleSchema`) | Read (`parseHealthReport`) |
|---|---|---|
| Missing status | refused | taken from legacy `ok`; neither present is an error |
| Status better than a check | refused | lowered to the worst check |
| `up`, `down`, `ok`, `error` | refused | read as pass or fail, per the draft |
| Check status it does not know | refused | read as `warn` |
| A check as a bare object, not an array | refused | read as a one-entry array |
| Mistyped known field, at any depth (`version: 2`, a check `output: {}`) | refused | dropped and named by path in `ignored` |
| Unknown report field | kept (product extension keys) | kept |
| Unknown sample field | refused | not applicable |

`worstStatus` orders fail > warn > pass and reads an empty list as pass. The draft leaves
the top-level status to the producer; health/v1 requires it to be at least the worst check,
so a reader never sees `pass` above a failing check.

## The sample row

`ts` (ISO 8601 with an offset), `target`, `kind`, `status` (`pass`, `warn`, `fail` or
`unknown`), and the optional `latencyMs`, `observed`, `output` and `dedupKey`. `source`
defaults to `probe`. `unknown` means the probe could not decide, such as an error inside the
probe; it never counts as up. Only imports set `dedupKey`, so a re-import adds nothing while
two identical probe results are both kept.

## The sample store

`openHealthStore(path)` opens a store-sqlite database (WAL) and applies `HEALTH_MIGRATIONS`;
`openHealthStore(path, { readonly: true })` skips migration for a reader. Opening a file
stamped by a newer schema throws `SchemaTooNewError`.

- `appendSamples(db, samples)` parses every row with `healthSampleSchema` first, then inserts
  all of them in one transaction and returns how many it wrote. One call per tick means one
  commit per tick, whatever the number of targets.
- Rows with a `dedupKey` are inserted with `INSERT OR IGNORE`, so a re-import adds nothing.
  Rows without one are always inserted.
- Nothing is ever removed. The module exports no delete, update or prune function, and
  triggers on `health_sample` abort a plain `UPDATE` or `DELETE`. They are a guard against
  mistakes, not a seal: a writer of the file can still drop them, and `INSERT OR REPLACE`
  removes conflicting rows without firing them.
- `readSamples(db, target, from, to)` returns `from <= ts < to`, oldest first, using the
  `(target, ts_ms)` index. `storeStats(db)` returns `rows`, `bytes` (main database pages),
  `oldestTs` and `newestTs`, so the cost of keeping everything stays visible.

## Uptime

```ts
import { appendSamples, openHealthStore, uptime } from "@titan-design/health";

const db = openHealthStore(":memory:");
appendSamples(db, [
  { ts: "2026-01-01T00:00:05Z", target: "factory", kind: "http", status: "pass" },
  { ts: "2026-01-01T00:02:05Z", target: "factory", kind: "http", status: "fail" },
]);
uptime(db, "factory", new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:03:00Z"));
// { slots: 3, up: 1, down: 1, unknown: 0, missing: 1, upShareOfWindow: 1/3,
//   upShareOfObserved: 0.5, gaps: [{ from: "...T00:01:00.000Z", to: "...T00:02:00.000Z" }] }
```

| Slot holds | Counts as |
|---|---|
| no sample | `missing`, never up |
| worst sample `pass` or `warn` | `up` |
| worst sample `unknown` | `unknown`, neither up nor down |
| worst sample `fail` | `down` |

- Slots are `tickSeconds` wide (60 by default) and aligned to the epoch, so they line up with
  a wall-clock minutely timer. Only whole slots inside `[from, to)` count.
- Several samples in one slot fold to the worst: fail > unknown > warn > pass.
- `upShareOfWindow` is `up / slots`; `upShareOfObserved` is `up / (up + down)`. Each is `null`
  when its denominator is 0, as in an empty window.
- Consecutive missing slots merge into one gap.

## The metrics subpath

`@titan-design/health/metrics` holds the schemas for the measurement workflow: `titan.metrics/v1`
(a system's registry entry: stores, metrics with source anchor, query, cadence, SLO and surfaces,
reports, last audit) and `titan.measurement-audit/v1` (an audit report). `validateEntry(entry,
"write" | "read")` dispatches on the entry's `schema` id. Write mode refuses unknown keys at every
depth; read mode keeps them, so an older reader survives a newer writer. The exports are
`metricsEntrySchema`, `metricsEntryReadSchema`, `measurementAuditSchema`,
`measurementAuditReadSchema`, `validateEntry`, and the vocabularies `METRIC_FAMILIES`,
`METRIC_UNITS`, `CADENCES` and `SURFACES`.

## What it deliberately does not do

- It holds no thresholds. Which fields make a product's check warn or fail is that product's
  policy, written as its own check functions.
- It does not serve a route or run a daemon. Samples are taken by a short-lived sampler,
  not by a resident process.
- It never prunes or samples down. Raw samples are kept for good, by owner decision.
- It does not infer restarts from gaps. A restart shorter than a tick leaves no gap; read the
  target's own restart counters from `observed` instead.

## Gotchas

- `parseHealthReport` returns `{ ok: false, error }` instead of throwing, and only when the
  payload is not an object or has neither a status nor a boolean `ok`. A probe should map
  that to a failing sample, not drop it. A mistyped field never fails the read; check
  `ignored` if identity depends on it, as a dropped `pid` does.
- The read result is typed `HealthReportReading`, the output of a separate loose read schema
  that shares its field types with the write schema. Every value it holds has been checked
  against the type it claims; `ignored` names what was dropped to get there, such as
  `checks.db:responseTime.0.output`.
- The report schema is loose on unknown keys by design, so a typo in an optional field name
  is not caught there; the sample schema is strict.

## Where it came from

New in TP-1651, the first unit of the in-host observability work. The append-only
sample store and uptime came in its third slice; the HTTP probe follows.
