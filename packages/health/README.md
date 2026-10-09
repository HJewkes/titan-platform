# @titan-design/health

The health/v1 report contract and the sample row a health probe stores, as zod schemas.

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

- `healthReportSchema` (zod, a peer dependency) is the write schema for a health route's
  payload. It follows draft-inadarei-api-health-check: `status` (`pass|warn|fail`), `checks`
  keyed `component:measurement` with an array of check objects each, `started_at` and `metrics`, plus the legacy `ok`, `version`, `pid`, `uptime_ms`
  and `port`. Product extension keys pass through. A `status` better than the worst check is
  refused.
- `parseHealthReport(payload)` is the read side and returns `{ ok, report, ignored }` or
  `{ ok, error }`. Only a status or a legacy boolean `ok` is required. The draft's
  `up`/`down`/`ok`/`error` aliases are accepted, unknown fields and check values are kept, a
  mistyped known field is dropped and named in `ignored`, a check status it does not know
  reads as `warn`, and the result is never better than its worst check.
- `worstStatus(statuses)` folds statuses as fail > warn > pass; an empty list is pass.
- `healthSampleSchema` is the strict write schema for one stored probe result: `ts`,
  `target`, `kind`, `status` (`pass|warn|fail|unknown`), `latencyMs`, `observed`, `output`,
  `source` (default `probe`) and `dedupKey` (imports only). Unknown fields are refused.
- `probeHttp(target, deps)` GETs a health route once and returns one sample. It never
  throws: a refused connection, a timeout, a non-2xx code, a body that is not a health payload
  or a wrong pid or port is `fail`, and an error inside the probe is `unknown`. `fetch`, the
  clock (`now`, `after`) and `expectedPid` are injected.

The append-only sample store and uptime arrive in later TP-1651 slices.
