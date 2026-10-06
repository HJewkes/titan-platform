---
"@titan-design/session-analytics": minor
---

Export `staleEpisodeSessions(db, ids?)`: the sessions `writeEpisodes` would change, newest last request first. It chooses each session's heuristic through the same `readSessionContexts` and `classifySession` step as `writeEpisodes`, so a consumer no longer keeps its own copy of the session-fact query. The README and reference page now document `blockedFlowReport`, `livenessReport` and `reviewFillReport` and the parsers they rest on.
