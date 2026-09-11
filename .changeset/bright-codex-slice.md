---
"@titan-design/agent": minor
"@titan-design/session-read": minor
"@titan-design/session-graph": minor
"@titan-design/store-sqlite": patch
"@titan-design/cluster": patch
---

Add bounded Codex execution, rollout discovery/decoding, and opt-in mixed-harness
session ingestion with format-aware search excerpts and error readback. Preserve
legacy Claude rows and references through additive conversation aliases. Prevent
orphaned contentless FTS row IDs from leaking stale terms after source replacement.
Recognize native shell missing-file diagnostics in error clustering.
