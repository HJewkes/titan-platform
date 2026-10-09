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
  `up`/`down`/`ok`/`error` aliases are accepted, unknown fields are kept, a mistyped known
  field at any depth is dropped and named by path in `ignored`, a check status it does not
  know reads as `warn`, and the result is never better than its worst check. The report is
  typed `HealthReportReading`, the output of a loose read schema that shares its field types
  with the write schema, so the type never claims more than was checked.
- `worstStatus(statuses)` folds statuses as fail > warn > pass; an empty list is pass.
- `healthSampleSchema` is the strict write schema for one stored probe result: `ts`,
  `target`, `kind`, `status` (`pass|warn|fail|unknown`), `latencyMs`, `observed`, `output`,
  `source` (default `probe`) and `dedupKey` (imports only). Unknown fields are refused.

The HTTP probe, the append-only sample store and uptime arrive in later TP-1651 slices.

## `@titan-design/health/metrics`

- `validateEntry(entry, mode)` picks the schema from the entry's own `schema` id and returns
  `{ ok, entry }` or `{ ok, errors }`. `mode` is `"write"` (unknown keys refused at every depth)
  or `"read"` (unknown keys kept).
- `metricsEntrySchema` / `metricsEntryReadSchema` cover `titan.metrics/v1`, a system's metric
  registry entry. `measurementAuditSchema` / `measurementAuditReadSchema` cover
  `titan.measurement-audit/v1`, an audit report.
- `METRICS_SCHEMA_ID`, `AUDIT_SCHEMA_ID`, `METRIC_FAMILIES`, `METRIC_UNITS`, `CADENCES` and
  `SURFACES` are the closed vocabularies.
