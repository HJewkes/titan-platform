---
'@titan-design/active-work': minor
---

Add `ingestSource`, which content-addresses a `.md` or `.txt` source's bytes into a new `cache_blob` table (graph migration 1005) and extracts its text to `sources/extracted/<stem>.md`. A second ingest of unchanged bytes is a no-op.
