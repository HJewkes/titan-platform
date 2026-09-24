---
"@titan-design/code-graph": minor
---

Store audit findings and model verdicts against a snapshot (TP-355). Migration 4 adds
snapshot-scoped `finding` and `verdict` tables, pruned with their snapshot. `findingKey`
identifies a finding by tool, signal, innermost symbol (or path), a hash of the normalized
flagged text, and a collision ordinal, so it survives inserted lines, unlike `Finding.id`.
New exports: `keyFindings`, `saveFindings`, `listFindings`, `saveVerdicts`, `listVerdicts`,
`carryForwardVerdicts` (copies a verdict when key and excerpt hash both match).

`SCHEMA_VERSION` is now 4, so an older code-graph build refuses a database this one opened.
`INDEX_VERSION` is unchanged.
