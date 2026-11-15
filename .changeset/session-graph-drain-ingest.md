---
"@titan-design/session-graph": minor
"@titan-design/session-miner": patch
---

session-graph now owns the drain ingest: `ingestDrain(graph, { limit })` clusters tool-result errors into recurring failure templates and returns a `DrainSummary`, `listTemplates(graph, limit)` reads them, and `DRAIN_TEMPLATE_MIGRATION` and `DRAIN_SCREENED_MIGRATION` carry the template, occurrence, clusterer_snapshot and drain_screened tables at versions 2000 and 2002. It adds a dependency on `@titan-design/cluster`. session-miner's `drain.ingest` and `drain.templates` commands become thin wrappers over them.
