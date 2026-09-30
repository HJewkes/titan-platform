---
"@titan-design/session-analytics": minor
---

Add `cacheTtlReport` and its pure core `cacheTtlWhatIf`: what a 5-minute prompt-cache TTL would
save against the 1h TTL. Each 1h cache write is repriced at the 5m rate, and every request gap of
5 minutes or more (`REBUILD_GAP_BANDS`, from `gapBand`) is charged a rebuild of the cache it read
at the 5m write rate. The result gives the net saving per role and per spawn profile, and
`lossRoles` flags the roles whose rebuilds make 5m a loss. `renderCacheTtlText` prints it. When
the graph has no `gap_ms`, the gap is derived from the session's previous request.
