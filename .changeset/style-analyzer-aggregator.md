---
"@titan-design/style-analyzer": minor
---

Add the rest of codewatch's analyzer, ported unchanged: `Aggregator` with
`computeConfidence`, `mapSeverity` and `lookupStability`; the `Enricher` with
`AI_ENRICHED_FEATURES` and `needsAiEnrichment`, running against an injected `LlmProvider`;
and the ingest corpus types. `zod` v4 is now a peer dependency, because style-profile needs
it at runtime.
