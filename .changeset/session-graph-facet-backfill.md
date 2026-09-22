---
"@titan-design/session-graph": minor
---

Backfill the audit facet of transcripts indexed before migration 4 (TP-267).

`backfillFacets(graph, transcripts, { limit, version })` re-reads each stale transcript from byte 0 to its watermark and replaces its rows in the eight audit tables, newest `file_mtime` first, 40 per call by default. It never writes the legacy tables, and it skips `missing` and `quarantined` transcripts. `refreshCorpus` calls it after indexing, rolls up the sessions it touched, and reports `facetsBackfilled` and `facetBacklog`; its new `facetLimit` option sets the per-pass cap. A read from byte 0 records the facet at the current `EXTRACT_VERSION`, while an append to a transcript whose facet is stale leaves the facet for the backfill.

`applyAudit`, `AUDIT_DDL`, `AUDIT_FACET`, `DEFAULT_FACET_LIMIT` and the `RefreshOptions`, `BackfillOptions` and `BackfillSummary` types are now exported.
