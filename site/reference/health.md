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
draft-inadarei-api-health-check: a `status` of `pass`, `warn` or `fail`, the named `checks`
behind it, `started_at` and `metrics`. The legacy fields (`ok`, `version`, `pid`,
`uptime_ms`, `port`) stay, so old readers keep working. It also defines the sample row a
health probe stores.

## When to reach for it

- A product builds its health payload: validate it with `healthReportSchema` before it
  leaves the process.
- A monitor or probe reads someone else's health payload: use `parseHealthReport`, which
  accepts legacy payloads and newer ones it does not fully know.
- A probe stores its results: write each one as a `healthSampleSchema` row.

Neighbours: serving the health route, with its pid file, is [daemon](./daemon.md); the SQLite
primitives under the sample store are [store-sqlite](./store-sqlite.md).

## Example

Verified against 0.0.0.

```ts
import { healthReportSchema, healthSampleSchema, parseHealthReport } from "@titan-design/health";

const report = healthReportSchema.parse({
  status: "warn",
  checks: { deploy: { status: "warn", output: "rolled back" }, github: { status: "pass" } },
  started_at: "2026-01-01T00:00:00Z",
  ok: true,
  pid: 4242,
  port: 7410,
});

parseHealthReport({ ok: true, pid: 4242 });
// { ok: true, report: { status: "pass", ok: true, pid: 4242 } }

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
| Unknown report field | kept (product extension keys) | kept |
| Unknown sample field | refused | not applicable |

`worstStatus` orders fail > warn > pass and reads an empty list as pass.

## The sample row

`ts` (ISO 8601 with an offset), `target`, `kind`, `status` (`pass`, `warn`, `fail` or
`unknown`), and the optional `latencyMs`, `observed`, `output` and `dedupKey`. `source`
defaults to `probe`. `unknown` means the probe could not decide, such as an error inside the
probe; it never counts as up. Only imports set `dedupKey`, so a re-import adds nothing while
two identical probe results are both kept.

## What it deliberately does not do

- It holds no thresholds. Which fields make a product's check warn or fail is that product's
  policy, written as its own check functions.
- It does not serve a route or run a daemon. Samples are taken by a short-lived sampler,
  not by a resident process.
- It never prunes. Raw samples are kept for good.

## Gotchas

- `parseHealthReport` returns `{ ok: false, error }` instead of throwing. A probe should map
  that to a failing sample, not drop it.
- The report schema is loose on unknown keys by design, so a typo in an optional field name
  is not caught there; the sample schema is strict.

## Where it came from

New in TP-1651, the first unit of the in-host observability work. The HTTP probe, the
append-only sample store and uptime follow in later slices of the same task.
