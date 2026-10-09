# @titan-design/health

The health/v1 report contract and the sample row a health probe stores, as zod schemas.

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

- `healthReportSchema` (zod, a peer dependency) is the write schema for a health route's
  payload. It follows draft-inadarei-api-health-check: `status` (`pass|warn|fail`), named
  `checks`, `started_at` and `metrics`, plus the legacy `ok`, `version`, `pid`, `uptime_ms`
  and `port`. Product extension keys pass through. A `status` better than the worst check is
  refused.
- `parseHealthReport(payload)` is the read side and returns `{ ok, report }` or `{ ok, error }`.
  A legacy payload with only `ok` reads as pass or fail, the draft's `up`/`down`/`ok`/`error`
  aliases are accepted, unknown fields are kept, a check status it does not know reads as
  `warn`, and the result is never better than its worst check.
- `worstStatus(statuses)` folds statuses as fail > warn > pass; an empty list is pass.
- `healthSampleSchema` is the strict write schema for one stored probe result: `ts`,
  `target`, `kind`, `status` (`pass|warn|fail|unknown`), `latencyMs`, `observed`, `output`,
  `source` (default `probe`) and `dedupKey` (imports only). Unknown fields are refused.

The HTTP probe, the append-only sample store and uptime arrive in later TP-1651 slices.
