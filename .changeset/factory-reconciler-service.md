---
"@titan-design/factory": patch
---

Add the GitHub backstop reconciler service (TP-3430): every read is a `github-api` pool claim at backstop priority, a refused claim writes nothing and moves no cursor, more than 2 skipped intervals logs `reconciler.starved`, and serve runs a non-blocking forced start pass behind `reconciler.enabled` (off by default). Migration 36 adds the reconciler's cursor table. `reconciler.intervalMs` defaults to 5 minutes and must be 5-10 minutes under `github.sources: webhook`.
