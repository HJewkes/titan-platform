---
"@titan-design/retrieval": minor
---

Add ordered recovery steps to the retrieval engine: `EngineOptions.recovery`, `recoveryTimeoutMs` (default 250) and `recoveryTrigger`, `SearchOptions.recover`, and `SearchResponse.recovered`. When fusion is empty and at least one retriever answered, each `RecoveryStep` rewrites the query in turn and the first rewrite with hits wins. A throwing or timed-out step adds a `recovery:<name>` degradation and the engine moves on (TP-6336).
