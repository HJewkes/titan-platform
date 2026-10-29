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
- A report compares like with like: every file row carries `runner_class` (`<runner>-<cpus>c`), indexed with file
  and project, and every run keeps its `host`.

Neighbours: service health samples are [health](./health.md); the migrations and watermark table under the store
are [store-sqlite](./store-sqlite.md).

## Example

Verified against 0.0.0.

```ts
import { ingestArtifact, openTimingStore, storeStats } from "@titan-design/test-timing";

const db = openTimingStore("timing.db");
const result = ingestArtifact(db, JSON.parse(text), { path: "raw/gha/2026-01/run.json.gz", sha256 });
// { runId: "gha:1001:1:1", inserted: true, files: 2 }; the same call again gives inserted: false
console.log(storeStats(db)); // { runs, files, bytes, oldestStartedAt, newestStartedAt }
```

## What it deliberately does not do

- It runs no reporter and downloads nothing. The reporter and the CI and spool ingesters live in the repo's scripts.
- It prunes nothing. File rows are compact and kept indefinitely; raw artifacts age out where they are archived,
  which is why each run row records `raw_path` and `raw_sha256`.

## Gotchas

- A record whose parse fails stores nothing: the run and its files go in one transaction.
- `ingestArtifact` keys on `run.id` alone. A changed record under an id already stored is ignored, not merged.
- The column for the run's head commit is `commit_sha`, because `COMMIT` is an SQL keyword.

## Where it came from

New. The per-file reporter landed first as a CI-only artifact with no consumer; this package is the corpus that
consumes it.
