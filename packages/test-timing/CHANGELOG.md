# @titan-design/test-timing

## 0.1.0

### Minor Changes

- 9ee3d26: Add `@titan-design/test-timing`: the `titan.test-timing/v1` artifact schema (strict on write, loose on read) and a
  SQLite corpus store with idempotent `ingestArtifact`, `runnerClass` and `storeStats`.
- e4850c4: Add corpus ingest. `ingestRecord` archives a record gzipped with a `SHA256SUMS` line and then stores it, skipping a run already held; `ingestGhArtifact` takes one downloaded `vitest-file-timing-*` CI artifact by name and gives a pre-header record a header from its run's metadata (`upgradeLegacyArtifact`); `ingestSpool` drains a local spool, rejecting a bad record with a reason; `ghRunFetched` and `markGhRunFetched` let a scheduled CI ingest skip run attempts it already fetched.
- 61b1b0a: Add `renderReportMarkdown` and `renderSlowerMarkdown`, which render a `timingReport` (anomalies, growth, suite runs, project trends) and a `slowerSince` result as markdown.
- dfdaef2: Add the corpus queries. `readSeries` reads one series per suite, project or file over full-scope runs, summing a sharded run's shards into one point and dropping a run missing a shard. `timingReport` gives each suite's newest runs against their rolling minimum (anomalous when `hold` runs in a row are over it), growth where a min-of-last-N rose 25% over its trailing baseline, and every project's trend. `slowerSince` lists what got slower after a cut, which `commitStartedMs` finds from a sha prefix. The pure `trendOf`, `growthOf`, `runVerdicts` and `shiftAt` are exported with their default rules.

### Patch Changes

- Updated dependencies [c58d555]
- Updated dependencies [c1f9297]
  - @titan-design/store-sqlite@0.5.0
