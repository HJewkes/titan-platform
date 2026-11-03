---
"@titan-design/test-timing": minor
---

Add corpus ingest. `ingestRecord` archives a record gzipped with a `SHA256SUMS` line and then stores it, skipping a run already held; `ingestGhArtifact` takes one downloaded `vitest-file-timing-*` CI artifact by name and gives a pre-header record a header from its run's metadata (`upgradeLegacyArtifact`); `ingestSpool` drains a local spool, rejecting a bad record with a reason; `ghRunFetched` and `markGhRunFetched` let a scheduled CI ingest skip run attempts it already fetched.
