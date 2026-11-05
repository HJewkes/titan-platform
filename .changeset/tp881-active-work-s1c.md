---
"@titan-design/active-work": minor
---

active-work indexes transcripts with the session-graph defaults, so no pass writes `tool_input` or `tool_result` spans or `context_block` rows, and transcript search scopes to `prompt` and `assistant_response` only (TP-881). A graph indexed earlier keeps its tool spans until a full rebuild, but search no longer reads them.

`RefreshSummary` and the daemon's `session index pass` log line carry `rowsWritten` (the pass's `total_changes()` delta) and `dbBytes` (`page_count * page_size` when the pass ends).
