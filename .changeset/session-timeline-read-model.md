---
"@titan-design/session-analytics": minor
---

Add the session timeline read model. `buildSessionTimeline(observations)` and `SessionTimelineAccumulator` fold session-read's normalized observations into turns, minute buckets with gaps of 10 minutes or more marked, a token and cost series with compaction marks, and tool, file, error and subagent breakdowns. `countAtOrBefore` answers how much had happened by a scrubbed time. `ToolFamily` is re-exported from session-read. The package now depends on `@titan-design/session-read` and `@titan-design/agent-protocol`.
