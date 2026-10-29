# test-timing: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You keep vitest per-file timing over many runs: `timingArtifactSchema` validates the `titan.test-timing/v1` record a reporter writes (unknown keys refused) and `parseTimingArtifact` reads one (unknown keys kept). `openTimingStore` and `ingestArtifact` keep each record as one `runs` row and a `files` row per test file in SQLite, idempotent on the run id, with a `runner_class` per row so a CI runner is never compared with a bigger host. For service health samples use health; for the SQLite primitives use store-sqlite.
