# test-timing

**Tier 1.** Depends on [store-sqlite](./store-sqlite.md); `zod` is a peer dependency.

```sh
npm install @titan-design/test-timing zod
```

## The problem it solves

A vitest run reports how long each file took, then the numbers are gone. CI kept one cache file per branch and
overwrote it, and local runs kept logs with no per-file numbers, so nobody could say whether a file had grown slower,
when, or on which runner.

This package defines one record, `titan.test-timing/v1`: a run header (runner, host, commit, scope, shard, cores,
load, wall time, exit) and one row per test file (collect, setup, test and total ms, and the test count). It also
stores those records in a SQLite corpus of `runs` and `files` rows that later queries read.

## When to reach for it

- A vitest reporter writes a timing record: validate it with `timingArtifactSchema`, which rejects unknown keys.
- An ingester reads a record from disk or a CI artifact: `parseTimingArtifact` keeps keys a newer reporter added.
- A corpus stores records: `openTimingStore`, then `ingestArtifact` once per record. A run id already in the store is
  a no-op, so a repeated or resumed ingest is safe.
- An ingester archives as it stores: `ingestRecord` writes the record gzipped under
  `<home>/raw/<runner>/<yyyy-mm>/` with a line in that month's `SHA256SUMS`, then stores it. `ingestGhArtifact` takes
  one downloaded CI artifact by name (`vitest-file-timing-<attempt>` or `...-shard<i>of<n>-<attempt>`) and gives a
  pre-header record a header from the run's `gh run view` metadata. `ingestSpool` drains a local spool directory.
- A scheduled CI ingest skips run attempts it already fetched: `ghRunFetched` and `markGhRunFetched`, kept in the
  store's watermark table.
- A guardrail reads the corpus: `timingReport` gives each suite's newest runs against their rolling minimum
  (`anomalies` when `hold` runs in a row are all `threshold` over it), `growth` for every suite, project or file whose
  min-of-last-N rose at least 25% and 500 ms over the minimum of the runs before, and every project's `trend`.
  `slowerSince(db, cutMs)` answers "what got slower since this commit or date"; `commitStartedMs` turns a sha prefix
  into the cut. All of them read full-scope runs only, one series per runner class and shard layout (`gha-4c`,
  `gha-4c/3shards`), with a sharded run's shards summed into one point.
- A report compares like with like: every file row carries `runner_class` (`<runner>-<cpus>c`), indexed with file
  and project, and every run keeps its `host`.

Neighbours: service health samples are [health](./health.md); the migrations and watermark table under the store
are [store-sqlite](./store-sqlite.md).

## Example

Verified against 0.0.0.

```ts
import { commitStartedMs, ingestArtifact, openTimingStore, slowerSince, storeStats, timingReport } from "@titan-design/test-timing";

const db = openTimingStore("timing.db");
const result = ingestArtifact(db, JSON.parse(text), { path: "raw/gha/2026-01/run.json.gz", sha256 });
// { runId: "gha:1001:1:1", inserted: true, files: 2 }; the same call again gives inserted: false
console.log(storeStats(db)); // { runs, files, bytes, oldestStartedAt, newestStartedAt }

const report = timingReport(db, { sinceMs: Date.now() - 14 * 86_400_000 });
report.anomalies; // suite runs held over their rolling minimum
report.growth; // [{ level: "file", project, file, growth: { baselineMs, currentMs, deltaMs, ratio, since } }]
slowerSince(db, commitStartedMs(db, "1a2b3c4") ?? Date.parse("2026-01-01"));
```

## What it deliberately does not do

- It runs no reporter and calls no `gh`. The reporter and the `scripts/test-timing.mjs` CLI that downloads CI
  artifacts live in the repo's scripts.
- It prunes nothing. File rows are compact and kept indefinitely; raw artifacts age out where they are archived,
  which is why each run row records `raw_path` and `raw_sha256`.

## Gotchas

- A record whose parse fails stores nothing: the run and its files go in one transaction.
- `ingestArtifact` keys on `run.id` alone. A changed record under an id already stored is ignored, not merged.
- A pre-header CI record (before the run header landed) has no test counts, node version, load or wall time; it is
  stored with `tests: 0`, `node: "unknown"` and `wallMs: 0`, on the hosted runner's 4 cores. A pull request's
  pre-header record is stored as `scoped`, since its scope was never written down.
- A per-file 25% growth rule cannot see a cost every file pays a little of: a suite-wide 15% rise moves no file 25%.
  The suite anomaly catches it instead. Its defaults (`ANOMALY_RULE`: 12% over the minimum of the last 10 runs, held
  for 2 runs) sit over the roughly 6% run-to-run swing of a hosted runner's suite total.
- A sharded run missing a shard is left out of every series, so a cancelled shard never reads as a fast suite.
- `ingestSpool` leaves a record modified in the last minute for the next pass, because the reporter may still be
  writing it.
- The column for the run's head commit is `commit_sha`, because `COMMIT` is an SQL keyword.

## Where it came from

New. The per-file reporter landed first as a CI-only artifact with no consumer; this package is the corpus that
consumes it.
