---
"@titan-design/session-analytics": minor
---

A scoped `staleEpisodeSessions` call and `readSessionContexts` no longer read `request_dedup`. They keep each request's earliest `(ts, transcript_id)` copy with a `NOT EXISTS` check over `idx_request_id`, so a call for a few sessions stops ranking every request in the graph. Results are unchanged. `staleEpisodeSessions` with no ids still reads the view.
