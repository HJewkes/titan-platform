---
"@titan-design/code-graph": minor
---

Add the convention layer, ported from codewatch (TP-130): `detectCommunities` (deterministic greedy-modularity communities with a `targetCount` and size cap), `buildConventionAreas`, `summarizeConventions` (injected `Summarizer`, summaries cached in `blob_cache` under `code-graph/community-summary` by model and prompt hash, returns hit and miss counts), `getConventionMap`, and `findConventions` (ranks areas for a question by summary embedding). No schema change.
