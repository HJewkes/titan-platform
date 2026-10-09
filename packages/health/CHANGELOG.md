# @titan-design/health

## 0.1.0

### Minor Changes

- d8ed566: Add `@titan-design/health` with the health/v1 contract after draft-inadarei-api-health-check, with `checks` keyed `component:measurement` and holding arrays as the draft does: `healthReportSchema` (strict write, product keys kept), `parseHealthReport` (loose read: legacy `ok`, the draft's aliases and unknown fields; a mistyped known field at any depth is dropped and named by path in `ignored`; typed `HealthReportReading`; never better than the worst check), `worstStatus`, and the strict `healthSampleSchema` for one stored probe result. zod is a peer dependency.
- d8ed566: Add the `./metrics` subpath: zod schemas for `titan.metrics/v1` registry entries and `titan.measurement-audit/v1` reports, plus `validateEntry(input, "write" | "read")`. Write mode refuses unknown keys; read mode keeps them.
- 060a8a2: Add the append-only sample store and uptime to `@titan-design/health`. `openHealthStore` opens a store-sqlite `health_sample` table, `appendSamples` validates every row and writes a whole tick in one transaction (rows with a `dedupKey` are written once), and `readSamples` and `storeStats` read it back. Nothing deletes, updates or prunes a sample: no export does, and triggers refuse it. `uptime` and the pure `foldUptime` report up, down, unknown and missing epoch-aligned slots separately, with both shares and the gaps; a missing slot is never up.

### Patch Changes

- Updated dependencies [1f7de27]
  - @titan-design/store-sqlite@0.4.0
