---
"@titan-design/active-work": minor
---

Add graph migration 1003, which creates empty `workspace_span` and `workspace_fts` tables (contentless-delete), a `workspaceSpans` handle on the opened graph, and a span-table selector for workspace-class readers. Nothing writes or reads the new tables by default yet; the selector picks them only when told to cut over.
