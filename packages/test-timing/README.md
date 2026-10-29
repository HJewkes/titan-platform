# @titan-design/test-timing

The `titan.test-timing/v1` record (one vitest run: a run header and a row per test file) and a SQLite corpus that
stores those records, so a file's timing can be followed across commits and runners.

```ts
import { ingestArtifact, openTimingStore, storeStats } from "@titan-design/test-timing";

const db = openTimingStore("timing.db");
ingestArtifact(db, JSON.parse(raw), { path: "raw/run.json.gz", sha256 });
storeStats(db); // { runs, files, bytes, oldestStartedAt, newestStartedAt }
```

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

See the [reference page](https://github.com/HJewkes/titan-platform/blob/main/site/reference/test-timing.md).
