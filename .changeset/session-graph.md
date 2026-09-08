---
"@titan-design/session-graph": minor
---

Build the session activity graph on the store kit: `openSessionGraph` with kit + domain
migrations, `applyDelta` (transactional writer with chunk-safe upserts and phase collapse),
`rollupSessions` and `reconcile` (recompute-never-accumulate), `indexTranscript` /
`refreshCorpus` with watermark resume, rewrite rewind, quarantine, and missing-source marking.
