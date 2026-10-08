---
"@titan-design/session-graph": minor
---

Add normalized readers: `hasNormalizedTables`, `countNormalizedSessions`, `countNormalizedEvents`, `normalizedSourcePath`, `normalizedConversationDetail` and `normalizedErrorFacts`. Every normalized reader, including `normalizedSessions` and `normalizedUsage`, now treats the tables as present only when both `normalized_event` and `normalized_source` exist. `normalizedConversationDetail` counts each turn's distinct tool calls in one grouped query.
