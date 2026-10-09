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
- A probe stores its results: write each one as a `healthSampleSchema` row.

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

## The HTTP probe

```ts
const sample = await probeHttp(
  { name: "factory", url: "http://127.0.0.1:7410/health", timeoutMs: 5000, expectPort: 7410, observe: ["build.sha"] },
  { expectedPid: () => readPid() },
);
```

`probeHttp` returns one sample and never throws for a target that is down.

| Answer | `status` | `output` |
|---|---|---|
| Connection refused or reset | `fail` | `unreachable: <code>` |
| No full answer within `timeoutMs` (headers and body) | `fail` | `timeout after <ms> ms` |
| Non-2xx, redirects included (they are not followed) | `fail` | `HTTP <code>` |
| 2xx body that is not JSON, or not a health payload | `fail` | `body is not JSON`, `payload: ...` |
| Payload `port` is not `expectPort`, or `pid` is not `expectedPid()` | `fail` | `identity: ...` |
| `expectedPid()` is null (no pid file) while the port answers | `fail` | `identity: ...` |
| Bad URL, or `expectedPid()` throws | `unknown` | `probe error: ...` |
| Otherwise | the payload's status via `parseHealthReport` | none |

Identity is the TP-1056 risk: a stranger answering 200 on the port must not read as up, so
a payload that reports no pid or port fails a check it was asked for. `latencyMs` runs on
the injected clock from before the request to after the body; the `expectedPid()` lookup is
not counted. `observed.code` holds the HTTP
code when there was one, and each `observe` dot path is copied under its own name; a missing
path is left out, never defaulted. The package never reads a pid file itself; the caller
passes `expectedPid`.

## What it deliberately does not do

- It holds no thresholds. Which fields make a product's check warn or fail is that product's
  policy, written as its own check functions.
- It does not serve a route or run a daemon. Samples are taken by a short-lived sampler,
  not by a resident process.
- It never prunes. Raw samples are kept for good.

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

New in TP-1651, the first unit of the in-host observability work. The append-only sample
store and uptime follow in later slices of the same task.
