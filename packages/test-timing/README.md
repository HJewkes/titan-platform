# @titan-design/test-timing

The `titan.test-timing/v1` record (one vitest run: a run header and a row per test file) and a SQLite corpus that
stores those records, so a file's timing can be followed across commits and runners.

```ts
import { ingestArtifact, openTimingStore, storeStats } from "@titan-design/test-timing";

const db = openTimingStore("timing.db");
ingestArtifact(db, JSON.parse(raw), { path: "raw/run.json.gz", sha256 });
storeStats(db); // { runs, files, bytes, oldestStartedAt, newestStartedAt }
```

## Scheduled ingest

`scripts/test-timing.mjs` fills the corpus at `~/.local/share/titan-test-timing/timing.db` (or
`$TITAN_TEST_TIMING_HOME`). `ingest-gh` downloads the timing artifacts of the newest finished `ci.yml` runs, main and
pull request alike, and skips run attempts it already fetched; `ingest-spool` drains the local spool that
`verify:changed` writes; `ingest-dir <dir> --gh-run <id> [--scope full]` ingests artifacts already downloaded (`--scope` says what a pre-header record never did); `stats` prints the
store's size; `ingest` runs the spool and CI passes together. `report [--days 30] [--json] [--out dir]` prints the
anomaly, growth and project-trend report, and with `--out` also leaves `report.md` and `report.json` there.
`slower --since <sha|date> [--json]` lists what got slower after a commit (where the corpus first ran it, else its
commit date) or a date. `ops/systemd/test-timing-ingest.{service,timer}` run `ingest` hourly, then rewrite
`~/.local/share/titan-test-timing/report.{md,json}` even when an ingest failed, on a Linux host with the
checkout at `~/projects/titan-platform`, built, and `gh` signed in. To install (an owner step):

```sh
pnpm -C ~/projects/titan-platform --filter @titan-design/test-timing... build
install -m 644 -t ~/.config/systemd/user ~/projects/titan-platform/ops/systemd/test-timing-ingest.service ~/projects/titan-platform/ops/systemd/test-timing-ingest.timer
systemctl --user daemon-reload
systemctl --user enable --now test-timing-ingest.timer
```

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

See the [reference page](https://github.com/HJewkes/titan-platform/blob/main/site/reference/test-timing.md).
